const sanitizeHtml = require('sanitize-html');
const Snowball = require('snowball-stemmers');

const stemmer = Snowball.newStemmer('russian');

const SANITIZE_OPTIONS = {
  allowedTags: [
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'mark',
    'code',
    'pre',
    'blockquote',
    'p',
    'br',
    'div',
    'span',
    'ul',
    'ol',
    'li',
    'a',
    'img',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  allowProtocolRelative: false,
};

const WORD_REGEX = /[A-Za-zА-Яа-яЁё]+/g;

function sanitizeContent(html = '') {
  return sanitizeHtml(html || '', SANITIZE_OPTIONS);
}

function stripHtml(text = '') {
  return sanitizeContent(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeWords(text = '') {
  return (text || '')
    .toLowerCase()
    .match(WORD_REGEX)
    ?.map((token) => token.trim())
    .filter(Boolean) || [];
}

function buildLemma(text = '') {
  return tokenizeWords(text).map((token) => stemmer.stem(token)).join(' ');
}

function buildLemmaTokens(text = '') {
  return tokenizeWords(text).map((token) => stemmer.stem(token));
}

function buildNormalizedTokens(text = '') {
  return tokenizeWords(text).join(' ');
}

module.exports = {
  sanitizeContent,
  stripHtml,
  buildLemma,
  buildLemmaTokens,
  buildNormalizedTokens,
};
