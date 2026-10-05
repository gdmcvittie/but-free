const fs = require('fs');
const u = JSON.parse(fs.readFileSync('server/data/users/112444482622066288524/user.json'));

async function main() {
  const metaRes = await fetch('https://www.googleapis.com/drive/v3/files/1h_B3fOonIInqIW8CrxCMaZi5UqzU8FQp?fields=id,name,size,mimeType', {
    headers: { Authorization: 'Bearer ' + u.accessToken }
  });
  console.log('Meta:', await metaRes.json());

  const headRes = await fetch('https://www.googleapis.com/drive/v3/files/1h_B3fOonIInqIW8CrxCMaZi5UqzU8FQp?alt=media', {
    headers: { Authorization: 'Bearer ' + u.accessToken, Range: 'bytes=0-100' }
  });
  console.log('Head status:', headRes.status);
  console.log('Content-Range:', headRes.headers.get('content-range'));
  console.log('Content-Length:', headRes.headers.get('content-length'));
}
main().catch(console.error);
