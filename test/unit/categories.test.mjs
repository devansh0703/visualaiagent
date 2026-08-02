import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf, focusScoreOf, topSites } from '../../shared/categories.js';

test('categoryOf classifies known work/distraction hosts', () => {
  assert.equal(categoryOf('https://github.com/foo').label, 'work');
  assert.equal(categoryOf('https://stackoverflow.com/q/1').label, 'work');
  assert.equal(categoryOf('https://www.youtube.com/watch?v=x').label, 'distraction');
  assert.equal(categoryOf('https://reddit.com/r/x').label, 'distraction');
  assert.equal(categoryOf('https://google.com/search?q=1').label, 'neutral');
  assert.equal(categoryOf('https://example.org/site').label, 'unknown');
});

test('categoryOf strips subdomains and www', () => {
  assert.equal(categoryOf('https://news.ycombinator.com').label, 'unknown');
  assert.equal(categoryOf('https://www.github.com').label, 'work');
  assert.equal(categoryOf('https://mail.google.com').label, 'neutral');
});

test('categoryOf matches deep subdomains of known hosts', () => {
  assert.equal(categoryOf('https://m.youtube.com/watch?v=x').label, 'distraction');
  assert.equal(categoryOf('https://mobile.twitter.com/u').label, 'distraction');
  assert.equal(categoryOf('https://www.bbc.com/news').label, 'neutral');
  assert.equal(categoryOf('https://api.github.com/repos').label, 'work');
  assert.equal(categoryOf('https://help.linear.app/x').label, 'work');
});

test('focusScoreOf computes 0..1 and buckets', () => {
  const pages = [
    { url: 'https://github.com/x' },
    { url: 'https://github.com/y' },
    { url: 'https://youtube.com/z' },
  ];
  const f = focusScoreOf(pages);
  assert.equal(f.score, 0.67);
  assert.equal(f.buckets.work, 2);
  assert.equal(f.buckets.distraction, 1);
  assert.equal(f.pages, 3);
});

test('focusScoreOf returns null on empty', () => {
  assert.equal(focusScoreOf([]), null);
  assert.equal(focusScoreOf(null), null);
});

test('topSites ranks hosts by visits', () => {
  const pages = [
    { url: 'https://github.com/a' },
    { url: 'https://github.com/b' },
    { url: 'https://youtube.com/c' },
  ];
  const top = topSites(pages);
  assert.equal(top[0].host, 'github.com');
  assert.equal(top[0].n, 2);
  assert.equal(top[0].category, 'work');
});
