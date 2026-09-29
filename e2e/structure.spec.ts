import { expect, test, type Page } from '@playwright/test';
import {
  buildStructureSamples
} from '../tests/fixtures/acceptance-wav';

/**
 * 结构完整性端到端验收：同一批“固定字节样本”覆盖
 * 区域外格式块、越界音频块、半帧尾部、合法扩展块四种情况。
 * 样本在 Node 侧拼装（Uint8Array），转成 Buffer 后交给真实页面，
 * 由 parseWavHeader 先判结构、再由浏览器 Web Audio 真实解码。
 *
 * 三类损坏样本必须稳定停在导入错误（CORRUPT），
 * 不允许进入解码/扫描阶段，也不允许出现候选规则比较入口；
 * 合法扩展块必须正常解码、帧数与时长正确，且比较入口可用。
 */

const samples = buildStructureSamples();

async function loadFile(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('file-input').click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({
    name,
    mimeType: 'audio/wav',
    buffer: Buffer.from(bytes)
  });
}

test.describe('WAV 结构损坏：导入状态与错误类别', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('区域外格式块：稳定判 CORRUPT，不生成扫描结果、无比较入口', async ({ page }) => {
    const s = samples.outOfRegionFmt;
    await loadFile(page, s.bytes, s.fileName);

    await expect(page.getByTestId('error-panel')).toBeVisible();
    await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
    await expect(page.getByTestId('error-detail')).toContainText('区域外');
    // 结构损坏：不允许产出任何结果，比较入口不出现
    await expect(page.getByTestId('summary-panel')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('compare-panel')).toHaveCount(0);
    await expect(page.getByTestId('audio-player')).toHaveCount(0);
  });

  test('越界音频块：稳定判 CORRUPT，不进入解码阶段', async ({ page }) => {
    const s = samples.dataBeyondRiff;
    await loadFile(page, s.bytes, s.fileName);

    await expect(page.getByTestId('error-panel')).toBeVisible();
    await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
    await expect(page.getByTestId('error-detail')).toContainText('越过 RIFF 区域末端');
    await expect(page.getByTestId('summary-panel')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('compare-panel')).toHaveCount(0);
  });

  test('半帧尾部：稳定判 CORRUPT，不按截短帧数出扫描结果', async ({ page }) => {
    const s = samples.halfFrameTail;
    await loadFile(page, s.bytes, s.fileName);

    await expect(page.getByTestId('error-panel')).toBeVisible();
    await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
    await expect(page.getByTestId('error-detail')).toContainText('残缺采样帧');
    // 旧行为会 floor(10/4)=2 帧继续解码；新结构检查必须在解码前拦下
    await expect(page.getByTestId('summary-panel')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('channel-card')).toHaveCount(0);
    await expect(page.getByTestId('compare-panel')).toHaveCount(0);
  });
});

test('合法扩展块：正常导入，帧数/时长正确，候选规则比较入口可用', async ({ page }) => {
  await page.goto('/');
  const s = samples.legalExtension;
  await loadFile(page, s.bytes, s.fileName);

  // 导入成功：无错误面板，出现基线结论
  await expect(page.getByTestId('error-panel')).toHaveCount(0);
  await expect(page.getByTestId('summary-panel')).toBeVisible();
  await expect(page.getByTestId('verdict')).toHaveText('可交付');

  // 帧数 80 @8000Hz = 10ms = 0.010s（静音，无削波段）
  await expect(page.locator('.metric-value').filter({ hasText: '0.010 s' })).toBeVisible();
  await expect(page.getByTestId('channel-card')).toHaveCount(1);
  await expect(page.getByTestId('channel-stat')).toHaveText('无削波段');

  // 后续比对入口存在：应用默认候选规则后给出与基线一致的比较结果
  const comparePanel = page.getByTestId('compare-panel');
  await expect(comparePanel).toBeVisible();
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-summary')).toBeVisible();
  await expect(page.getByTestId('baseline-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('candidate-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('no-diff')).toBeVisible();
});

test('同一损坏字节文件多次导入：错误类别保持稳定（不随解码阶段漂移）', async ({ page }) => {
  await page.goto('/');
  const s = samples.halfFrameTail;
  for (let i = 0; i < 2; i++) {
    await loadFile(page, s.bytes, `${s.fileName}-${i}`);
    await expect(page.getByTestId('error-panel')).toBeVisible();
    await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
    await expect(page.getByTestId('summary-panel')).toHaveCount(0);
  }
});
