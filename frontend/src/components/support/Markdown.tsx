import { Fragment } from 'react';
import { markdown, type Inline } from '../../lib/support';

function Text({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : p.code ? <code key={i}>{p.text}</code> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}

/** A knowledge document's Markdown as React elements: no HTML from the text is ever injected (ADR-054). */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="kb-doc">
      {markdown(source).map((b, i) => {
        if (b.kind === 'h') {
          const H = (`h${Math.min(4, b.level + 1)}`) as 'h2' | 'h3' | 'h4';
          return <H key={i}><Text parts={b.text} /></H>;
        }
        if (b.kind === 'p') return <p key={i}><Text parts={b.text} /></p>;
        const L = b.kind;
        return (
          <L key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Text parts={it.text} />
                {it.sub.length > 0 && (
                  <ul>
                    {it.sub.map((s, k) => (
                      <li key={k}><Text parts={s} /></li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </L>
        );
      })}
    </div>
  );
}
