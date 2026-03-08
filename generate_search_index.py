#!/usr/bin/env python3
"""Generate a search index JSON from the wiki HTML pages."""

import json
import os
import re
from html.parser import HTMLParser

WIKI_DIR = os.path.join(os.path.dirname(__file__), 'docs', 'wiki')
OUTPUT = os.path.join(os.path.dirname(__file__), 'docs', 'search-index.json')

PAGES = [
    'getting-started.html',
    'thread-inventory.html',
    'pattern-design.html',
    'pattern-viewer.html',
    'import-export.html',
    'project-management.html',
    'desktop-sync.html',
    'installation.html',
    'administration.html',
    'deployment.html',
    'faq.html',
]


def slugify(text):
    """Match the slug algorithm in docs/js/main.js (lines 94-97)."""
    slug = text.strip().lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug


class WikiParser(HTMLParser):
    """Extract h1, h2 headings and body text from a wiki page."""

    def __init__(self):
        super().__init__()
        self.entries = []
        self.page_title = ''
        self._in_tag = None       # current tag we're capturing text for
        self._depth = 0           # nesting depth for skipped tags
        self._skip_tags = {'script', 'style', 'nav', 'header', 'footer', 'svg'}
        self._skip_depth = 0
        self._current_heading = ''
        self._current_heading_id = ''
        self._current_text = []
        self._in_content = False   # inside .wiki-content
        self._found_h1 = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if self._skip_depth > 0 or tag in self._skip_tags:
            self._skip_depth += 1
            return
        # Detect wiki-content (may be <main> or <div>)
        cls = attrs_dict.get('class', '')
        if 'wiki-content' in cls:
            self._in_content = True
        if not self._in_content:
            return
        if tag == 'h1' and not self._found_h1:
            self._in_tag = 'h1'
            self._current_text = []
        elif tag == 'h2':
            # Flush previous section
            self._flush_section()
            self._in_tag = 'h2'
            self._current_text = []
            self._current_heading_id = attrs_dict.get('id', '')

    def handle_endtag(self, tag):
        if self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if not self._in_content:
            return
        if tag == 'h1' and self._in_tag == 'h1':
            self.page_title = ' '.join(''.join(self._current_text).split())
            self._found_h1 = True
            self._in_tag = None
            self._current_text = []
        elif tag == 'h2' and self._in_tag == 'h2':
            heading_text = ' '.join(''.join(self._current_text).split())
            self._current_heading = heading_text
            if not self._current_heading_id:
                self._current_heading_id = slugify(heading_text)
            self._in_tag = None
            self._current_text = []

    def handle_data(self, data):
        if self._skip_depth > 0:
            return
        if self._in_tag in ('h1', 'h2'):
            self._current_text.append(data)
        elif self._in_content and self._found_h1:
            self._current_text.append(data)

    def handle_entityref(self, name):
        from html import unescape
        self.handle_data(unescape(f'&{name};'))

    def handle_charref(self, name):
        from html import unescape
        self.handle_data(unescape(f'&#{name};'))

    def _flush_section(self):
        text = ' '.join(''.join(self._current_text).split())
        if not text:
            return
        self.entries.append({
            'page': '',  # filled in by caller
            'pageTitle': self.page_title,
            'section': self._current_heading,
            'sectionId': self._current_heading_id,
            'text': text,
        })
        self._current_heading = ''
        self._current_heading_id = ''
        self._current_text = []

    def finish(self):
        """Flush the last section."""
        self._flush_section()


def parse_page(filename):
    filepath = os.path.join(WIKI_DIR, filename)
    with open(filepath, 'r', encoding='utf-8') as f:
        html = f.read()

    parser = WikiParser()
    parser.feed(html)
    parser.finish()

    for entry in parser.entries:
        entry['page'] = filename

    return parser.entries


def main():
    index = []
    for page in PAGES:
        entries = parse_page(page)
        index.extend(entries)
        print(f'  {page}: {len(entries)} sections')

    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f'\nWrote {len(index)} entries to {OUTPUT} ({size_kb:.1f} KB)')


if __name__ == '__main__':
    main()
