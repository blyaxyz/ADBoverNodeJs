
/*!
 * WebAdbHelper (browser-safe)
 * Version: 1.1.0
 * Helps pick Android device serial through WebUSB without claimInterface,
 * with optional fallback via webadb.core.js and temporary adb server stop.
 * Exports global window.WebAdbHelper
 */
(function (root, factory) {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.WebAdbHelper = factory.browser();
  } else if (typeof module === 'object' && module.exports) {
    module.exports = {
      loadCore: async () => { throw new Error('[WebAdbHelper] Browser-only.'); },
      pickSerial: async () => { throw new Error('[WebAdbHelper] Browser-only.'); },
      killAdbServer: async () => { throw new Error('[WebAdbHelper] Browser-only.'); },
      startAdbServer: async () => { throw new Error('[WebAdbHelper] Browser-only.'); },
    };
  }
}(this, {
  browser() {
    const DEFAULT_FILTERS = [
      { classCode: 255, subclassCode: 66, protocolCode: 1 },
      { vendorId: 0x18D1 }, { vendorId: 0x04E8 }, { vendorId: 0x22B8 }, { vendorId: 0x12D1 },
      { vendorId: 0x2A70 }, { vendorId: 0x05C6 }, { vendorId: 0x2D95 }
    ];
    function ensureWebUsb() {
      if (!('usb' in navigator)) throw new Error('WebUSB недоступен. Используйте Chrome/Edge и https:// или http://localhost.');
    }
    async function loadCore(src = './webadb.core.js') {
      if (window.Adb) return;
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => resolve(); // тихо: нет ядра — просто не используем fallback
        document.head.appendChild(s);
      });
      if (!window.Adb) throw new Error('webadb.core.js загружен, но window.Adb не появился.');
    }
    async function killAdbServer(url) { if (url) try { await fetch(url, { method: 'POST' }); } catch(_){} }
    async function startAdbServer(url) { if (url) try { await fetch(url, { method: 'POST' }); } catch(_){} }
    async function tryWebUsbSerial(filters) {
      ensureWebUsb();
      const device = await navigator.usb.requestDevice({ filters: filters && filters.length ? filters : DEFAULT_FILTERS });
      try {
        await device.open(); // без claimInterface
        const sn = (device.serialNumber || '').trim();
        return sn || '';
      } finally { try { await device.close(); } catch(_){} }
    }
    async function tryAdbSerialViaWebUsbFallback(opts) {
      const { coreSrc = './webadb.core.js', onAuthPrompt, killServerUrl, startServerUrl } = opts || {};
      await killAdbServer(killServerUrl);
      try {
        await loadCore(coreSrc);
        const webusb = await window.Adb.open('WebUSB');
        if (!webusb.isAdb()) throw new Error('Интерфейс не ADB');
        const adb = await webusb.connectAdb('host::', () => {
          try { onAuthPrompt?.(webusb.device?.productName); } catch(_) {}
          alert('Подтвердите USB-отладку на устройстве: ' + (webusb.device?.productName || 'Android device'));
        });
        const out = await adb.shell('getprop ro.serialno');
        const resp = await out.receive();
        const serial = new TextDecoder().decode(resp.data).trim();
        await webusb.close();
        if (!serial) throw new Error('Не удалось получить ro.serialno');
        return serial;
      } finally {
        await startAdbServer(startServerUrl);
      }
    }
    async function pickSerial(options = {}) {
      const { filters = DEFAULT_FILTERS, killServerUrl, startServerUrl, useWebUsbOnly = false, coreSrc = './webadb.core.js', onAuthPrompt } = options;
      try {
        const sn = await tryWebUsbSerial(filters);
        if (sn) return sn;
      } catch(e) { console.warn('[WebAdbHelper] WebUSB direct failed:', e && e.message); }
      if (useWebUsbOnly) throw new Error('Не удалось получить serial через WebUSB (useWebUsbOnly=true). Закройте Android Studio/scrcpy/adb и попробуйте снова.');
      try { return await tryAdbSerialViaWebUsbFallback({ coreSrc, onAuthPrompt, killServerUrl, startServerUrl }); } catch (e) { console.warn('[WebAdbHelper] fallback failed:', e && e.message); return ''; }
    }
    return { loadCore, pickSerial, killAdbServer, startAdbServer, DEFAULT_FILTERS };
  }
}));
