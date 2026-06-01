const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navigate to the tender detail page (the one from your screenshot)
  const tenderId = '7b9a986b-de14-4dc0-8653-dcc9c5b3bb2f';
  await page.goto(`http://localhost:5173/tenders/${tenderId}`, { waitUntil: 'networkidle' });
  
  // Wait for the estimate section to load
  await page.waitForSelector('.estimate-doc-tab-count', { timeout: 5000 }).catch(() => {
    console.log('Estimate tab not visible yet - may need to scroll or click');
  });
  
  // Take a screenshot to see the current state
  await page.screenshot({ path: 'test-vor-before.png', fullPage: true });
  console.log('Screenshot saved: test-vor-before.png');
  
  // Check if the "Объединённый ВОР" count is visible and what it shows
  const counts = await page.$$eval('.estimate-doc-tab-count', els => 
    els.map(el => el.textContent)
  );
  console.log('Current VOR counts:', counts);
  
  // Try to find the "Смета" tab and click it to ensure estimate items are loaded
  const estimateTab = await page.$('button:has-text("Смета")');
  if (estimateTab) {
    await estimateTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-vor-estimate-tab.png', fullPage: true });
  }
  
  console.log('Test completed. Check the screenshots for verification.');
  await browser.close();
})().catch(console.error);
