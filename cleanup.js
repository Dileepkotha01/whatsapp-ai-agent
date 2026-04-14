const fs = require('fs');

let c = fs.readFileSync('server.js', 'utf8');

c = c.replace(/[\uFE0F\uFE0E]/g, '');

c = c.replace(/` \*/g, '`*');
c = c.replace(/` /g, '`');
c = c.replace(/`️ /g, '`');
c = c.replace(/\\n\\n To/g, '\\n\\nTo');
c = c.replace(/\\n /g, '\\n');

// Specific replacements:
c = c.replace(/- ONLY output <RUN_EXTRACTOR> when they are clearly "Done" or have provided enough for a listing.`;/, 
`- ONLY output <RUN_EXTRACTOR> when they are clearly "Done" or have provided enough for a listing.\n- DO NOT use any emojis, icons, or special formatting markers. Speak exactly like a real human mapping plain text.\`;`);

c = c.replace(/`\*Successfully captured!\* I've forwarded these property details to our verification team. They will review it shortly! `/g, 
`\`Successfully captured. I've forwarded these property details to our verification team for a quick review.\``);

c = c.replace(/Sorry, I'm having a quick moment — please try again! /g, 
`Sorry, I'm having a quick moment — please try again!`);

c = c.replace(/`\*Your property details have been captured!\*\\nIt has been sent to our verification team. You'll receive a confirmation and the live link as soon as it's approved.`/g, 
`\`Your property details have been captured.\\nIt has been sent to our verification team. You'll receive a confirmation and the live link as soon as it's approved.\``);

fs.writeFileSync('server.js', c);
console.log('Cleanup done!');
