const fs = require('fs');

const path = '/home/ryasr/personal-project/tenrary-x/dashboard/src/roomsList.js';
let content = fs.readFileSync(path, 'utf8');

// Replace any hardcoded handlers with object calls or fix the listeners
if (!content.includes('await refreshRoomsList(handlers)')) {
  console.log("Handlers look misaligned in roomsList.js");
}

console.log("Done checking roomsList.js");
