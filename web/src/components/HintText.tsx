import { Fragment } from 'react';

/** Renders provider hints, where `backticks` mark commands, with those parts as inline code. */
export function HintText({ text }: { text: string }) {
  const parts = text.split('`');
  // An odd number of parts means every backtick has a partner.
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}
