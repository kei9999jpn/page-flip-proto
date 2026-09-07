// 計測フック。GA_ID が空の間は何もしない（KEI から測定IDが来たらここに入れる）
export const GA_ID = '';

declare global {
  interface Window { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void; __app?: unknown }
}

if (GA_ID) {
  const g = document.createElement('script');
  g.async = true;
  g.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(g);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function (...args: unknown[]) { window.dataLayer!.push(args); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { anonymize_ip: true });
}

export function track(name: string, params?: Record<string, unknown>): void {
  try { if (window.gtag) window.gtag('event', name, params || {}); } catch { /* noop */ }
}
