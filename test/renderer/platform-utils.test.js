'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isDarwinPlatform, primaryModifier, secondaryPlatformModifier, modifierComboText, superKeyGlyph
} = require('../../src/renderer/platform-utils.js');

function withPlatform(platform, fn) {
  const previous = global.window;
  global.window = { edexCapabilities: { platform } };
  try {
    fn();
  } finally {
    if (previous === undefined) delete global.window;
    else global.window = previous;
  }
}

test('primaryModifier reads the Meta key on darwin, Ctrl everywhere else', () => {
  withPlatform('darwin', () => {
    assert.equal(primaryModifier({ metaKey: true, ctrlKey: false }), true);
    assert.equal(primaryModifier({ metaKey: false, ctrlKey: true }), false);
  });
  withPlatform('linux', () => {
    assert.equal(primaryModifier({ metaKey: true, ctrlKey: false }), false);
    assert.equal(primaryModifier({ metaKey: false, ctrlKey: true }), true);
  });
});

test('secondaryPlatformModifier is always the complementary key, not a fixed one', () => {
  withPlatform('darwin', () => {
    assert.equal(secondaryPlatformModifier({ metaKey: false, ctrlKey: true }), true);
    assert.equal(secondaryPlatformModifier({ metaKey: true, ctrlKey: false }), false);
  });
  withPlatform('linux', () => {
    assert.equal(secondaryPlatformModifier({ metaKey: true, ctrlKey: false }), true);
    assert.equal(secondaryPlatformModifier({ metaKey: false, ctrlKey: true }), false);
  });
});

test('isDarwinPlatform defaults to false with no window/capabilities at all', () => {
  const previous = global.window;
  delete global.window;
  try {
    assert.equal(isDarwinPlatform(), false);
  } finally {
    global.window = previous;
  }
});

test('modifierComboText leaves macOS glyphs untouched on darwin', () => {
  withPlatform('darwin', () => {
    assert.equal(modifierComboText('⇧⌘L'), '⇧⌘L');
    assert.equal(modifierComboText('⌘⇧.'), '⌘⇧.');
  });
});

test('modifierComboText rewrites both glyph orderings and single modifiers off darwin', () => {
  withPlatform('linux', () => {
    assert.equal(modifierComboText('⇧⌘L'), 'Ctrl+Shift+L');
    assert.equal(modifierComboText('⌘⇧.'), 'Ctrl+Shift+.');
    assert.equal(modifierComboText('⌘F'), 'Ctrl+F');
    assert.equal(modifierComboText('⌥⌘C'), 'Alt+Ctrl+C');
    assert.equal(modifierComboText('⌘T'), 'Ctrl+T');
  });
});

test('superKeyGlyph distinguishes darwin, win32 and the Linux default', () => {
  withPlatform('darwin', () => assert.equal(superKeyGlyph(), '⌘'));
  withPlatform('win32', () => assert.equal(superKeyGlyph(), 'Win'));
  withPlatform('linux', () => assert.equal(superKeyGlyph(), 'Super'));
  withPlatform('other', () => assert.equal(superKeyGlyph(), 'Super'));
});
