function normalize(text) {
  return text.normalize('NFKC').toLocaleLowerCase('ru').trim();
}

function differsByOneEdit(first, second) {
  let longer = Array.from(first);
  let shorter = Array.from(second);
  if (longer.length < shorter.length) [longer, shorter] = [shorter, longer];
  if (longer.length - shorter.length > 1) return false;

  const mismatch = longer.findIndex((letter, index) => letter !== shorter[index]);
  if (mismatch < 0) return false;
  const tailMatches = (longerStart, shorterStart) =>
    longer.slice(longerStart).every((letter, index) => letter === shorter[shorterStart + index]);

  if (longer.length !== shorter.length) return tailMatches(mismatch + 1, mismatch);
  if (tailMatches(mismatch + 1, mismatch + 1)) return true;
  return longer[mismatch] === shorter[mismatch + 1] &&
    longer[mismatch + 1] === shorter[mismatch] &&
    tailMatches(mismatch + 2, mismatch + 2);
}

function matches(text, keyword, allowTypos = true) {
  const input = normalize(text);
  const normalized = normalize(keyword);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u');
  if (exact.test(input)) return true;
  if (!allowTypos || !/^\p{L}{4,}$/u.test(normalized)) return false;
  const words = input.match(/[\p{L}\p{N}_]+/gu) || [];
  return words.some(word => /^\p{L}+$/u.test(word) && differsByOneEdit(word, normalized));
}

function findMatchingRule(rules, text) {
  return rules.find(rule => matches(text, rule.keyword, false)) ??
    rules.find(rule => matches(text, rule.keyword));
}

module.exports = {matches, findMatchingRule};
