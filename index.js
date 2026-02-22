const express = require('express');
const axios = require('axios');
require('dotenv').config();
const https = require('https');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔹 TikTok env
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REFRESH_TOKEN = process.env.TIKTOK_REFRESH_TOKEN;

// 🔹 Funzione riusabile per scaricare il video da R2
async function downloadVideoToBuffer(videoUrl) {
  console.log('⬇️  Downloading video from R2...');
  const videoResponse = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
  });
  const videoBuffer = Buffer.from(videoResponse.data);
  const videoSize = videoBuffer.length;
  console.log(`✅ Video downloaded: ${(videoSize / (1024 * 1024)).toFixed(2)} MB`);
  return { videoBuffer, videoSize };
}

// 🔹 Funzione core Pinterest: media + upload (multipart) + pin
async function uploadPinterestVideoPin({
  video_url,
  title,
  description,
  tags,
  channel_name,
  pinterest_board_id,
  pinterest_profile,
  pinterest_access_token,
  youtube_channel_url,
}) {
  try {
    console.log('📌 [Pinterest] Starting upload...');
    console.log(`   Channel: ${channel_name}`);
    console.log(`   Board ID: ${pinterest_board_id}`);
    console.log(`   Profile: ${pinterest_profile}`);
    console.log(`   Video URL: ${video_url}`);
    console.log(`   YouTube URL: ${youtube_channel_url}`);

    // 1) Scarica il video da R2
    const { videoBuffer, videoSize } = await downloadVideoToBuffer(video_url);

    // 2) Register media upload
    console.log('📝 [Pinterest] Registering media upload (POST /v5/media)...');
    const mediaCreateResponse = await axios.post(
      'https://api.pinterest.com/v5/media',
      {
        media_type: 'video',
      },
      {
        headers: {
          Authorization: `Bearer ${pinterest_access_token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const mediaId =
      mediaCreateResponse.data.media_id ||
      mediaCreateResponse.data.id;
    const uploadUrl = mediaCreateResponse.data.upload_url;
    const uploadParams = mediaCreateResponse.data.upload_parameters;

    console.log(`✅ [Pinterest] Media created: ${mediaId}`);
    console.log(`   Upload URL: ${uploadUrl}`);
    console.log('   upload_parameters:', uploadParams);

    if (!mediaId || !uploadUrl || !uploadParams) {
      throw new Error('Missing mediaId, uploadUrl or upload_parameters from /v5/media');
    }

    // 3) Upload del file al presigned upload_url come multipart/form-data (S3 POST)
    console.log('📤 [Pinterest] Uploading video file as multipart/form-data...');

    const fd = new FormData();

    // Aggiungi TUTTI i campi di upload_parameters nel form
    for (const key of Object.keys(uploadParams)) {
      fd.append(key, uploadParams[key]);
    }

    // Campo file (S3 presigned POST si aspetta "file") [web:6][web:223][web:255]
    fd.append('file', videoBuffer, {
      filename: 'video.mp4',
      contentType: 'video/mp4',
      knownLength: videoSize,
    });

    const uploadResponse = await axios.post(uploadUrl, fd, {
      headers: {
        ...fd.getHeaders(), // Content-Type multipart/form-data con boundary corretto
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true, // vogliamo leggere anche 204
    });

    console.log('   [Pinterest] Upload HTTP status:', uploadResponse.status);
    if (uploadResponse.status !== 204 && uploadResponse.status !== 201 && uploadResponse.status !== 200) {
      console.error('❌ [Pinterest] Upload to S3 did not return success status');
      console.error('Response headers:', uploadResponse.headers);
      console.error('Response data:', uploadResponse.data);
      throw new Error(`Pinterest S3 upload failed with status ${uploadResponse.status}`);
    }

    console.log('✅ [Pinterest] Video uploaded to upload_url (multipart/form-data)');

    // 4) Poll dello stato media
    console.log('⏱️  [Pinterest] Checking media status (GET /v5/media/{media_id})...');
    let mediaStatus = 'registered';
    let attempts = 0;
    const maxAttempts = 10;
    const delayMs = 3000;

    while (attempts < maxAttempts && mediaStatus !== 'succeeded') {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      try {
        const mediaGetResponse = await axios.get(
          `https://api.pinterest.com/v5/media/${mediaId}`,
          {
            headers: {
              Authorization: `Bearer ${pinterest_access_token}`,
            },
          }
        );
        mediaStatus = mediaGetResponse.data.status || mediaGetResponse.data.media?.status;
        console.log(`   [Pinterest] Media status attempt ${attempts}: ${mediaStatus}`);
        if (mediaStatus === 'failed') {
          throw new Error('Pinterest media upload failed');
        }
      } catch (err) {
        console.warn(
          '[Pinterest] Error checking media status:',
          err.response?.data || err.message
        );
      }
    }

    if (mediaStatus !== 'succeeded') {
      console.warn(
        `⚠️  [Pinterest] Media status is "${mediaStatus}" after polling, proceeding anyway`
      );
    } else {
      console.log('✅ [Pinterest] Media status succeeded, creating Pin...');
    }

    // 5) Crea il Pin /v5/pins
    const finalDescription = description || title || '';
    const finalTitle = title || description || 'New Pin';

    let tagList = [];
    if (tags) {
      tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }

    console.log('📌 [Pinterest] Creating pin (POST /v5/pins)...');
    const pinCreateResponse = await axios.post(
        'https://api.pinterest.com/v5/pins',
        {
          board_id: pinterest_board_id,
          media_source: {
            source_type: 'video_id',   // 🔴 prima era 'media_id'
            media_id: String(mediaId), // deve essere stringa di cifre
          },
          title: finalTitle,
          description: finalDescription,
          note: finalDescription,
          link: youtube_channel_url || undefined,
          // tag_names: tagList,
        },
        {
          headers: {
            Authorization: `Bearer ${pinterest_access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

    const pinId = pinCreateResponse.data.id || pinCreateResponse.data.pin_id;
    const pinLink =
      pinCreateResponse.data.link ||
      pinCreateResponse.data.url ||
      `https://www.pinterest.com/pin/${pinId}`;

    console.log(`✅ [Pinterest] Pin created: ${pinId}`);
    console.log(`   URL: ${pinLink}`);

    return {
      success: true,
      pin_id: pinId,
      pin_url: pinLink,
      raw_pin: pinCreateResponse.data,
    };
  } catch (error) {
    console.error(
      '❌ [Pinterest] Error in uploadPinterestVideoPin:',
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'TikTok & Pinterest Upload Service Running',
    version: '2.1.0',
    timestamp: new Date().toISOString(),
  });
});

// 🔹 TikTok main upload endpoint
app.post('/upload', async (req, res) => {
  try {
    const { video_url, title, description, channel_name } = req.body;

    console.log(`🎬 Starting TikTok upload for: ${channel_name}`);
    console.log(`   Title: ${title}`);
    console.log(`   Video URL: ${video_url}`);

    // Step 1: Get access token from refresh token
    console.log('🔑 Step 1: Getting access token...');
    const tokenResponse = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: TIKTOK_REFRESH_TOKEN,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    console.log('✅ Access token obtained');

    // Step 2: Download video from R2
    console.log('⬇️  Step 2: Downloading video from R2...');
    const { videoBuffer, videoSize } = await downloadVideoToBuffer(video_url);
    console.log(`✅ Video downloaded for TikTok: ${(videoSize / (1024 * 1024)).toFixed(2)} MB`);

    // Step 3: Initialize upload session
    console.log('🔄 Step 3: Initializing TikTok upload session...');
    console.log(`   Video size: ${videoSize} bytes`);

    const initResponse = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: title,
          description: description,
          privacy_level: 'SELF_ONLY',
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          video_url: '',
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      }
    );

    const { publish_id, upload_url } = initResponse.data.data;
    console.log(`✅ Upload session initialized: ${publish_id}`);

    // Step 4: Upload video
    console.log('📤 Step 4: Uploading video to TikTok...');

    await axios.put(upload_url, videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoSize,
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
    });

    console.log('✅ Video uploaded successfully to TikTok!');

    res.json({
      success: true,
      video_id: publish_id,
      publish_id: publish_id,
      message: 'Video pubblicato con successo su TikTok',
      channel: channel_name,
    });
  } catch (error) {
    console.error('❌ Error TikTok:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
      details: error.response?.data,
    });
  }
});

// 🔹 Pinterest main upload endpoint
app.post('/upload/pinterest', async (req, res) => {
  try {
    const {
      row_number,
      sheet_id,
      video_url,
      title,
      description,
      tags,
      channel_name,
      pinterest_board_id,
      pinterest_profile,
      pinterest_access_token,
      youtube_channel_url,
    } = req.body;

    console.log('🚀 [Pinterest] New request from n8n...');
    console.log(`   row_number: ${row_number}`);
    console.log(`   sheet_id: ${sheet_id}`);
    console.log(`   channel_name: ${channel_name}`);
    console.log(`   board_id: ${pinterest_board_id}`);

    if (!video_url || !pinterest_board_id || !pinterest_access_token) {
      console.error('❌ [Pinterest] Missing required fields');
      return res.status(400).json({
        success: false,
        error: 'MISSING_REQUIRED_FIELDS',
        details: {
          video_url: !!video_url,
          pinterest_board_id: !!pinterest_board_id,
          pinterest_access_token: !!pinterest_access_token,
        },
      });
    }

    const result = await uploadPinterestVideoPin({
      video_url,
      title,
      description,
      tags,
      channel_name,
      pinterest_board_id,
      pinterest_profile,
      pinterest_access_token,
      youtube_channel_url,
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: 'PINTEREST_UPLOAD_FAILED',
        details: result.error,
        row_number,
        sheet_id,
      });
    }

    return res.json({
      success: true,
      message: 'Pin pubblicato con successo su Pinterest',
      pin_id: result.pin_id,
      pin_url: result.pin_url,
      row_number,
      sheet_id,
      channel_name,
      pinterest_board_id,
    });
  } catch (error) {
    console.error('❌ [Pinterest] Route error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      row_number: req.body?.row_number,
      sheet_id: req.body?.sheet_id,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TikTok & Pinterest Upload Service running on port ${PORT}`);
  console.log(`📡 TikTok Endpoint:    POST /upload`);
  console.log(`📡 Pinterest Endpoint: POST /upload/pinterest`);
});

