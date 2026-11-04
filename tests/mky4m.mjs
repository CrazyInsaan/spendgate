import QRCode from 'qrcode'; import fs from 'fs';
const W=640,H=480, q=QRCode.create('upi://pay?pa=camera.test@okaxis&pn=Camera%20Test',{}); const n=q.modules.size, m=q.modules.data;
const cell=Math.floor(320/(n+8)), size=cell*(n+8), ox=(W-size)/2|0, oy=(H-size)/2|0;
const Y=Buffer.alloc(W*H,90);
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const mx=Math.floor(x/cell)-4,my=Math.floor(y/cell)-4;const dark=mx>=0&&my>=0&&mx<n&&my<n&&m[my*n+mx];Y[(oy+y)*W+ox+x]=dark?20:235;}
const UV=Buffer.alloc(W*H/4,128);
let out=[Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)];
for(let i=0;i<10;i++)out.push(Buffer.from('FRAME\n'),Y,UV,UV);
fs.writeFileSync('qr.y4m',Buffer.concat(out));
