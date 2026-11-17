// Collects TUA's stop numbers for every line, in order, from tua.es's own line pages.
// How to use: open https://www.tua.es/es/lineas-y-horarios/ in a desktop browser, open the
// developer console (F12 > Console), paste this whole file and press Enter. After a few
// seconds it downloads tua-stops.json. Send that file back, and run
//   python3 scripts/match_stops.py public/data/tua.json public/data/stop-map.json tua-stops.json
(async () => {
  const links = [...new Set([...document.querySelectorAll('a[href*="/lineas-y-horarios/linea-"]')]
    .map(a => a.href.split('#')[0]))];
  const out = {};
  for (const url of links) {
    const doc = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html');
    for (const dir of ['ida', 'vuelta']) {
      const tab = doc.querySelector(`a[href="#${dir}"] span`);
      const box = doc.getElementById(dir);
      if (!tab || !box) continue;
      out[tab.textContent.trim()] = [...box.querySelectorAll('ul.paradas > li > a')]
        .map(a => [a.querySelector('span')?.textContent.trim(), a.querySelector('strong')?.textContent.trim()])
        .filter(([n]) => n);
    }
    console.log(url, 'done');
    await new Promise(r => setTimeout(r, 300)); // be gentle with their server
  }
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'tua-stops.json' });
  document.body.appendChild(a); a.click(); a.remove();
  console.log(`Saved ${Object.keys(out).length} directions:`, Object.keys(out).join(', '));
})();
