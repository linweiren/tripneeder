import fs from 'fs';

// 手動從 .env 提取金鑰
const envContent = fs.readFileSync('.env', 'utf-8');
const match = envContent.match(/GOOGLE_PLACES_API_KEY=["']?([^"'\r\n]+)["']?/);
const key = match ? match[1] : null;

if (!key) {
  console.error('❌ 找不到 GOOGLE_PLACES_API_KEY');
  process.exit(1);
}

// 模擬使用者輸入：高雄市鹽埕區，美食偏好
const input = {
  input: {
    category: 'food',
    tags: ['hidden_gems'],
    location: {
      name: '高雄市鹽埕區',
      lat: 22.6234,
      lng: 120.2828
    }
  },
  location: { name: '高雄市鹽埕區' }
};

const city = input.location.name || '';
const categoryMap = {
  food: 'top rated restaurants, local snacks, famous food, night markets',
};
const tagMap = {
  hidden_gems: 'off the beaten path, local secrets, unique',
};

const textQuery = `${city} ${categoryMap.food} ${tagMap.hidden_gems}`.trim();
console.log('🔍 搜尋關鍵字：', textQuery);

async function testNearby() {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating',
      },
      body: JSON.stringify({
        textQuery,
        languageCode: 'zh-TW',
        maxResultCount: 10,
        locationBias: {
          circle: {
            center: { latitude: 22.6234, longitude: 120.2828 },
            radius: 5000.0,
          }
        },
      }),
    });

    const data = await response.json();
    if (data.places) {
      console.log('✅ 找到地點：');
      data.places.forEach(p => {
        console.log(`- ${p.displayName.text} (${p.formattedAddress}) [ID: ${p.id}]`);
      });
    } else {
      console.log('❌ 找不到地點', data);
    }
  } catch (error) {
    console.error('❌ 請求失敗', error);
  }
}

testNearby();
