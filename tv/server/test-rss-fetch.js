import https from 'https';

async function testFetch() {
  console.log('Testing native fetch...');
  try {
    const res = await fetch('https://myrss.org/eztv', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    console.log('Fetch status:', res.status, res.statusText);
    const text = await res.text();
    console.log('Fetch text length:', text.length, 'starts with:', text.slice(0, 100));
  } catch (err) {
    console.error('Fetch error:', err.message);
  }

  console.log('\nTesting https.get...');
  try {
    const req = https.get('https://myrss.org/eztv', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }, (res) => {
      console.log('https.get status:', res.statusCode, res.headers);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('https.get length:', data.length, 'starts with:', data.slice(0, 100));
      });
    });
    req.on('error', (e) => console.error('https.get error:', e.message));
  } catch (err) {
    console.error('https error:', err.message);
  }
}

testFetch();
