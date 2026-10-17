// Rolling numbers. A value renders one span per character; when it changes, the characters that differ
// roll up (value rose) or down (value fell) and the whole value tints green or red for 1.2 seconds.
// Screen readers get the plain text from a visually hidden copy; the character spans are hidden from them.
// CSS lives in explore.css (.odo); prefers-reduced-motion keeps the colour change and drops the roll.

const FLASH_MS = 1200;
const ROLL_MS = 300;

function cells(text) {
  return [...text].map(ch => {
    const cell = document.createElement('span');
    cell.className = /\d/.test(ch) ? 'odo-cell odo-digit' : 'odo-cell';
    const glyph = document.createElement('span');
    glyph.className = 'odo-char';
    glyph.textContent = ch;
    cell.append(glyph);
    return cell;
  });
}

/** A rolling value: <span class="odo …"><span class="visually-hidden">$24.4K</span><span aria-hidden>…</span></span>. */
export function odometer(text = '', className = '') {
  const root = document.createElement('span');
  root.className = `odo ${className}`.trim();
  const spoken = document.createElement('span');
  spoken.className = 'visually-hidden';
  const track = document.createElement('span');
  track.className = 'odo-track';
  track.setAttribute('aria-hidden', 'true');
  root.append(spoken, track);
  root.dataset.value = '';
  setOdometer(root, text, 0);
  return root;
}

/**
 * Shows `text`. `direction` is the sign of the change in the underlying number (1 rose, -1 fell, 0 same
 * or unknown). Only a real change of the same kind of value animates: the first render and a change of
 * unit (USD to a pair asset) just swap the text.
 */
export function setOdometer(root, text, direction = 0) {
  text = String(text ?? '');
  const [spoken, track] = root.children, previous = root.dataset.value ?? '';
  if (previous === text && track.childElementCount) return root;
  root.dataset.value = text;
  spoken.textContent = text;
  const sameShape = previous && previous.length === text.length && previous.replace(/\d/g, '0') === text.replace(/\d/g, '0');
  if (!previous || !sameShape || !direction) {
    track.replaceChildren(...cells(text));
  } else {
    const way = direction > 0 ? 'up' : 'down';
    [...text].forEach((ch, i) => {
      const cell = track.children[i];
      if (!cell || cell.dataset.char === ch || cell.lastElementChild?.textContent === ch) return;
      const old = cell.lastElementChild, next = document.createElement('span');
      next.className = `odo-char odo-in-${way}`;
      next.textContent = ch;
      cell.dataset.char = ch;
      if (old) { old.className = `odo-char odo-out-${way}`; }
      cell.append(next);
      setTimeout(() => { if (old?.parentNode === cell && cell.lastElementChild === next) old.remove(); next.classList.remove(`odo-in-${way}`); }, ROLL_MS + 40);
    });
  }
  if (previous && direction) {
    root.dataset.flash = direction > 0 ? 'up' : 'down';
    clearTimeout(root._flash);
    root._flash = setTimeout(() => { delete root.dataset.flash; }, FLASH_MS);
  }
  return root;
}

/** Sign of a change between two numbers, ignoring missing values and float noise. */
export function changeDirection(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return 0;
  const scale = Math.max(Math.abs(before), Math.abs(after), 1e-30);
  return Math.abs(after - before) / scale < 1e-9 ? 0 : after > before ? 1 : -1;
}
