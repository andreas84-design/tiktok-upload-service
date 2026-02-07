const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_REFRESH_TOKEN = process.env.TIKTOK_REFRESH_TOKEN;

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'TikTok Upload Service Running',
    version: '1.0.1',
    timestamp: new Date().toISOString()
  });
});

// Main upload endpoint
app.post('/upload', async (req, res) => {
  try {
    const { video_url, title, description, channel_name } = req.body;

    console.log(`🎬 Starting TikTok upload for: ${channel_name}`);
    console.log(`   Title: ${title}`);
    console.log(`   Video URL: ${video_url}`);

    // Step 1: Get access token from refresh token
    console.log('🔑 Step 1: Getting access token...');
    const tokenResponse = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', 
      new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: TIKTOK_REFRESH_TOKEN
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = tokenResponse.data.access_token;
    console.log('✅ Access token obtained');

    // Step 2: Download video from R2
    console.log('⬇️  Step 2: Downloading video from R2...');
    const videoResponse = await axios.get(video_url, { 
      responseType: 'arraybuffer',
      timeout: 120000
    });
    const videoBuffer = Buffer.from(videoResponse.data);
    const videoSize = videoBuffer.length;
    console.log(`✅ Video downloaded: ${(videoSize / (1024 * 1024)).toFixed(2)} MB`);

    // Step 3: Initialize upload session
    console.log('🔄 Step 3: Initializing TikTok upload session...');
    
    // ✅ FIX: Calcola chunk size e total chunks prima
    const chunkSize = 10 * 1024 * 1024; // 10MB
    const totalChunks = Math.ceil(videoSize / chunkSize);
    
    console.log(`   Video size: ${videoSize} bytes`);
    console.log(`   Chunk size: ${chunkSize} bytes`);
    console.log(`   Total chunks: ${totalChunks}`);
    
    const initResponse = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      {
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: chunkSize,
          total_chunk_count: totalChunks
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8'
        }
      }
    );

    const { publish_id, upload_url } = initResponse.data.data;
    console.log(`✅ Upload session initialized: ${publish_id}`);

    // Step 4: Upload video in chunks
    console.log('📤 Step 4: Uploading video chunks...');

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, videoSize);
      const chunk = videoBuffer.slice(start, end);

      console.log(`   Uploading chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)...`);
      
      await axios.put(upload_url, chunk, {
        headers: {
          'Content-Range': `bytes ${start}-${end - 1}/${videoSize}`,
          'Content-Length': chunk.length,
          'Content-Type': 'video/mp4'
        },
        timeout: 180000
      });
    }
    console.log('✅ All chunks uploaded');

    // Step 5: Publish video
    console.log('🎉 Step 5: Publishing video on TikTok...');
    const publishResponse = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: title,
          description: description,
          privacy_level: 'SELF_ONLY',
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_url: upload_url,
          publish_id: publish_id
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8'
        }
      }
    );

    const videoId = publishResponse.data.data.publish_id;
    console.log(`✅ Video published successfully! ID: ${videoId}`);

    res.json({
      success: true,
      video_id: videoId,
      publish_id: publish_id,
      message: 'Video pubblicato con successo su TikTok',
      channel: channel_name
    });

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
      details: error.response?.data
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TikTok Upload Service running on port ${PORT}`);
  console.log(`📡 Endpoint: POST /upload`);
});
