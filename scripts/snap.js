import { chromium } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import path from 'node:path';

const BASE_URL = process.env.SNAP_URL || 'http://localhost:4500';
const ARTICLE_ID = process.env.SNAP_ARTICLE_ID || 'test-article';
const OUT_DIR = process.env.SNAP_OUT || 'snapshots';
const VIEWPORT = { width: 1400, height: 900 };

async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

async function capture() {
  await ensureOutDir();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const targetUrl = `${BASE_URL}/article/${ARTICLE_ID}`;
  console.log(`[snap] opening ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('.drag-handle', { timeout: 15000 });
  await page.waitForTimeout(300); // чуть-чуть дождаться финальной раскладки

  const metrics = await page.evaluate(() => {
    const container = document.querySelector('#blocksContainer');
    const containerRect = container?.getBoundingClientRect();
    const handles = Array.from(document.querySelectorAll('.drag-handle')).map((el) => {
      const rect = el.getBoundingClientRect();
      const blockId = el.dataset.blockId || el.closest('.block')?.dataset?.blockId || null;
      const block = blockId ? document.querySelector(`.block[data-block-id="${blockId}"]`) : el.closest('.block');
      const text = block?.querySelector('.block-text')?.textContent?.trim() || '';
      return {
        blockId,
        text: text.slice(0, 64),
        absolute: {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        relativeToContainer: containerRect
          ? {
              left: rect.left - containerRect.left,
              right: rect.right - containerRect.left,
              top: rect.top - containerRect.top,
              bottom: rect.bottom - containerRect.top,
            }
          : null,
      };
    });
    return {
      url: window.location.href,
      container: containerRect
        ? {
            left: containerRect.left,
            right: containerRect.right,
            width: containerRect.width,
            height: containerRect.height,
          }
        : null,
      handles,
    };
  });

  const screenshotPath = path.join(OUT_DIR, 'drag-handles.png');
  const metricsPath = path.join(OUT_DIR, 'drag-handles.json');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2), 'utf-8');
  await browser.close();
  console.log(`[snap] saved ${screenshotPath}`);
  console.log(`[snap] saved ${metricsPath}`);
}

capture().catch((error) => {
  console.error('[snap] failed:', error);
  process.exitCode = 1;
});
