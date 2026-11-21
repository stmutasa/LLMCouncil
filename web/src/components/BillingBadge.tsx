import type { BillingMode } from '../../../shared/types';

/** "subscription" in a neutral tone; "API key" in the warning tone because it may cost money. */
export function BillingBadge({ billing }: { billing: BillingMode }) {
  if (billing === 'subscription') return <span className="badge">subscription</span>;
  if (billing === 'api-key') {
    return (
      <span className="badge warning" title="This call was billed to an API key, not your subscription">
        API key
      </span>
    );
  }
  return null;
}
