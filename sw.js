// 홈 화면에 설치한 앱의 화면 파일을 폰에 저장해 두고, 인터넷이 없을 때도 열리게 합니다.
// 화면 파일을 고치면 CACHE 이름을 바꿔 주세요. (그래야 폰이 새 파일을 받습니다)
const CACHE = 'onemath2-20261027a';
const FILES = [
  './', 'index.html', 'style.css?v=20261027m1', 'mobile.css?v=20261027m1',
  'curriculum.js?v=20261027m1', 'ai.js?v=20261027m1', 'pdf.js?v=20261027m1', 'app.js?v=20261027m1',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

// 이 앱의 파일만 저장본을 씁니다. AI 회사로 가는 요청은 건드리지 않습니다.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))),
  );
});
