// v0.10.1 B3: E (and Shift+E) leaves the office editor, as its shortcut card says; typing an
// "e" in an input (the furniture search) does not.
// Run: node tests/test_v101_editor_e.mjs
import { launch, openEditor, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v101_editor_e';
const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const { page, errors } = await openEditor(browser);
  const mode = () => page.evaluate(() => !!editMode);
  t.ok(await mode(), 'editor open');
  await page.mouse.click(600, 420); // after clicking the canvas, too
  await page.keyboard.press('e');
  t.ok(!(await mode()), 'E leaves the editor');
  await page.keyboard.press('e');
  t.ok(await mode(), 'E opens it again');
  await page.keyboard.press('Shift+E');
  t.ok(!(await mode()), 'Shift+E leaves it too');
  await page.keyboard.press('e');
  const search = page.locator('input[placeholder="Search furniture"]').first();
  if (await search.count()) {
    await search.focus();
    await page.keyboard.type('desk');
    t.ok(await mode(), 'typing "desk" in the furniture search keeps the editor open');
    t.ok((await search.inputValue()) === 'desk', 'the e reached the input', await search.inputValue());
  } else {
    t.ok(false, 'furniture search input found');
  }
  t.ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
