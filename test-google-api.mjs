import fs from 'fs';

// 手動從 .env 提取金鑰
const envContent = fs.readFileSync('.env', 'utf-8');
const match = envContent.match(/GOOGLE_PLACES_API_KEY=["']?([^"'\r\n]+)["']?/);
const key = match ? match[1] : null;

if (!key) {
  console.error('❌ 找不到 GOOGLE_PLACES_API_KEY');
  process.exit(1);
}

// 測試 Geocoding API (反查台北 101 座標)
const latlng = '25.033976,121.564421';
const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latlng}&key=${key}&language=zh-TW`;

async function testApi() {
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status === 'OK') {
      console.log('✅ Geocoding API 測試成功！');
      console.log('地址：', data.results[0].formatted_address);
      process.exit(0);
    } else {
      console.error('❌ API 回傳錯誤狀態：', data.status);
      if (data.error_message) console.error('錯誤訊息：', data.error_message);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 請求失敗：', error.message);
    process.exit(1);
  }
}

testApi();
