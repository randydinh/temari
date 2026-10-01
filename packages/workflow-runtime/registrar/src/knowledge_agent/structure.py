"""Deterministic visible HTML and Markdown section spans; no source instructions run."""
from collections import Counter
from html.parser import HTMLParser
import re


class VisibleHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.stack, self.heading = [], [], None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        blocked = (bool(self.stack and self.stack[-1][1]) or tag in {
            'head', 'script', 'style', 'nav', 'template', 'noscript', 'svg', 'form'}
            or 'hidden' in attrs or attrs.get('aria-hidden') == 'true'
            or bool(re.search(r'(display\s*:\s*none|visibility\s*:\s*hidden)', attrs.get('style', ''), re.I)))
        if tag not in {'br','hr','img','input','meta','link','wbr','area','base','embed','source','track','col','param'}:
            self.stack.append((tag, blocked))
        if blocked:
            return
        if re.fullmatch('h[1-6]', tag):
            self.parts.append('\n' + '#' * int(tag[1]) + ' ')
            self.heading = attrs.get('id')
        elif tag == 'pre':
            self.parts.append('\n```\n')
        elif tag in {'p','div','section','article','details','summary','li','tr','blockquote'}:
            self.parts.append('\n')
        elif tag in {'br','hr'}:
            self.parts.append('\n')
        elif tag in {'td','th'}:
            self.parts.append(' | ')

    def handle_endtag(self, tag):
        blocked = bool(self.stack and self.stack[-1][1])
        if not blocked:
            if re.fullmatch('h[1-6]', tag):
                if self.heading and re.fullmatch(r'[\w.-]+', self.heading):
                    self.parts.append(' {#' + self.heading + '}')
                self.heading = None
                self.parts.append('\n')
            elif tag == 'pre':
                self.parts.append('\n```\n')
            elif tag in {'p','div','section','article','li','tr','summary','details','blockquote'}:
                self.parts.append('\n')
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if not self.stack or not self.stack[-1][1]:
            self.parts.append(data)


def html_extractor(path, raw):
    parser = VisibleHTML()
    parser.feed(raw.decode('utf-8'))
    parser.close()
    lines,code = [],False
    for line in ''.join(parser.parts).splitlines():
        if line == '```':
            code = not code
            lines.append(line)
        elif code:
            lines.append(line)
        else:
            value = re.sub(r'[\t \r\f\v]+', ' ', line).strip()
            if value or not lines or lines[-1]:
                lines.append(value)
    text = '\n'.join(lines).strip() + '\n'
    return dict(text=text, extraction='html-visible-1')


def sections(text):
    """Normalized character spans, explicit anchors and heading parents.

    Parent spans include their children; own_text_end distinguishes parent prose
    from child evidence. Fenced code and frontmatter do not become headings.
    """
    rows, stack, counts, position, fence = [], [], Counter(), 0, None
    frontmatter = text.startswith('---\n')
    for line in text.splitlines(keepends=True):
        if frontmatter:
            if position and line.strip() == '---':
                frontmatter = False
            position += len(line)
            continue
        fenced = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fenced:
            token = fenced[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            position += len(line)
            continue
        match = None if fence else re.match(r'^ {0,3}(#{1,6})\s+(.+?)\s*$', line)
        if match:
            level, title = len(match[1]), match[2].rstrip('#').strip()
            explicit = re.search(r'\s*\{#([\w.-]+)\}$', title)
            anchor = explicit[1] if explicit else re.sub(r'[^\w.-]+', '-', title.casefold()).strip('-') or 'section'
            if explicit:
                title = title[:explicit.start()].strip()
            counts[anchor] += 1
            anchor = anchor if counts[anchor] == 1 else f'{anchor}-{counts[anchor]}'
            if rows:
                rows[-1]['own_text_end'] = position
            while stack and stack[-1]['level'] >= level:
                stack.pop()['text_end'] = position
            row = dict(anchor=anchor, title=title, level=level, parent=stack[-1]['anchor'] if stack else None,
                text_start=position, content_start=position+len(line), text_end=len(text), own_text_end=len(text))
            rows.append(row)
            stack.append(row)
        position += len(line)
    for row in rows:
        body = text[row['content_start']:row['text_end']]
        meaningful = re.sub(r'\[[^\]]*\]\([^)]*\)', '', body)
        meaningful = re.sub(r'(?m)^\s*#+.*$|^\s*[-*+]\s*$', '', meaningful)
        row['operative'] = bool(re.search(r'\w', meaningful))
    return rows
