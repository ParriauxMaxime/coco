#!/usr/bin/env bash
# Builds the fictional acme/widgets repo with a 3-branch stack: export-api -> export-ui -> export-toggle.
set -euo pipefail
ROOT=/tmp/coco-demo
R=$ROOT/widgets
rm -rf "$R" "$ROOT/widgets.git"
mkdir -p "$R"
cd "$R"
export GIT_AUTHOR_NAME="Alex Martin" GIT_AUTHOR_EMAIL="alex@acme.example"
export GIT_COMMITTER_NAME="Alex Martin" GIT_COMMITTER_EMAIL="alex@acme.example"
commit() { # date msg
  export GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1"
  git add -A
  git commit -q -m "$2"
}
git init -q -b main

mkdir -p src/invoices src/api/routes src/auth src/client src/config test
cat > package.json <<'EOF'
{
  "name": "@acme/widgets",
  "version": "2.14.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "test"]
}
EOF
cat > AGENTS.md <<'EOF'
# acme/widgets

- Money is integer cents end to end.
- Every route checks the caller's permission before reading the body.
- Tests cover the refusal path, not only the happy path.
EOF
cat > src/invoices/invoice.ts <<'EOF'
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void';

export interface Invoice {
  id: string;
  accountId: string;
  number: string;
  customerName: string;
  status: InvoiceStatus;
  totalCents: number;
  currency: 'EUR' | 'USD' | 'GBP';
  issuedAt: Date;
  paidAt: Date | null;
}

export const formatCents = (cents: number) => (cents / 100).toFixed(2);
EOF
cat > src/invoices/invoice-repository.ts <<'EOF'
import type { Invoice, InvoiceStatus } from './invoice';
import { db } from '@/db';

export interface InvoiceQuery {
  accountId: string;
  status?: InvoiceStatus;
  from?: Date;
  to?: Date;
}

export async function findInvoices(query: InvoiceQuery): Promise<Invoice[]> {
  return db.invoices.find({
    accountId: query.accountId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to ? { issuedAt: { $gte: query.from, $lte: query.to } } : {}),
  });
}
EOF
cat > src/auth/permissions.ts <<'EOF'
export type Permission = 'invoices:read' | 'invoices:write' | 'invoices:export' | 'settings:write';

export interface Caller {
  userId: string;
  accountId: string;
  permissions: Permission[];
}

export const can = (caller: Caller, permission: Permission) => caller.permissions.includes(permission);
EOF
cat > src/api/routes/invoices.routes.ts <<'EOF'
import { Router } from 'express';
import { can } from '@/auth/permissions';
import { findInvoices } from '@/invoices/invoice-repository';

export const invoicesRouter = Router();

invoicesRouter.get('/invoices', async (req, res) => {
  if (!can(req.caller, 'invoices:read')) return res.status(403).json({ error: 'forbidden' });
  const invoices = await findInvoices({ accountId: req.caller.accountId, status: req.query.status as never });
  res.json({ invoices });
});
EOF
cat > src/client/InvoicesPage.tsx <<'EOF'
import { useInvoices } from './use-invoices';

export function InvoicesPage() {
  const { invoices, loading } = useInvoices();
  if (loading) return <p>Loading invoices…</p>;
  return (
    <section>
      <header className="toolbar">
        <h1>Invoices</h1>
      </header>
      <table>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{i.customerName}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
EOF
cat > src/config/flags.ts <<'EOF'
export const flags = {
  newBillingPortal: { default: false, description: 'Stripe-hosted billing portal' },
  bulkRefunds: { default: false, description: 'Refund several invoices at once' },
} as const;

export type FlagCode = keyof typeof flags;
EOF
commit "2026-10-01T09:12:00+02:00" "chore: set up invoices module, API and client"

git checkout -q -b export-api
cat > src/invoices/csv-export.ts <<'EOF'
import type { Invoice } from './invoice';
import { formatCents } from './invoice';

export const CSV_COLUMNS = ['number', 'customer', 'status', 'total', 'currency', 'issued_at', 'paid_at'] as const;

const escapeCell = (value: string) => {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
};

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export function invoiceToRow(invoice: Invoice): string[] {
  return [
    invoice.number,
    invoice.customerName,
    invoice.status,
    formatCents(invoice.totalCents),
    invoice.currency,
    isoDate(invoice.issuedAt),
    isoDate(invoice.paidAt),
  ];
}

export function toCsv(invoices: Invoice[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const invoice of invoices) lines.push(invoiceToRow(invoice).map(escapeCell).join(','));
  return lines.join('\n') + '\n';
}
EOF
commit "2026-10-06T10:04:00+02:00" "feat(invoices): serialize invoices to CSV"
cat > src/api/routes/export.routes.ts <<'EOF'
import { Router } from 'express';
import { can } from '@/auth/permissions';
import { findInvoices } from '@/invoices/invoice-repository';
import { toCsv } from '@/invoices/csv-export';

export const exportRouter = Router();

exportRouter.get('/invoices/export.csv', async (req, res) => {
  if (!can(req.caller, 'invoices:read')) return res.status(403).json({ error: 'forbidden' });
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const invoices = await findInvoices({ accountId: req.caller.accountId, from, to });
  const csv = toCsv(invoices);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="invoices-${Date.now()}.csv"`);
  res.send(csv);
});
EOF
commit "2026-10-06T15:40:00+02:00" "feat(api): add GET /invoices/export.csv"
cat > test/csv-export.test.ts <<'EOF'
import { describe, expect, it } from 'vitest';
import { toCsv } from '@/invoices/csv-export';
import type { Invoice } from '@/invoices/invoice';

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'inv_1',
  accountId: 'acc_1',
  number: 'INV-0042',
  customerName: 'Globex, Inc.',
  status: 'paid',
  totalCents: 129900,
  currency: 'EUR',
  issuedAt: new Date('2026-09-30T22:30:00Z'),
  paidAt: new Date('2026-10-02T08:00:00Z'),
  ...over,
});

describe('toCsv', () => {
  it('writes a header and one row per invoice', () => {
    const csv = toCsv([invoice()]);
    expect(csv.split('\n')[0]).toBe('number,customer,status,total,currency,issued_at,paid_at');
    expect(csv).toContain('INV-0042,"Globex, Inc.",paid,1299.00,EUR,2026-09-30,2026-10-02');
  });

  it('quotes cells holding a quote', () => {
    expect(toCsv([invoice({ customerName: 'The "Best" Co' })])).toContain('"The ""Best"" Co"');
  });
});
EOF
commit "2026-10-07T09:20:00+02:00" "test(invoices): cover CSV header, quoting and amounts"

git checkout -q -b export-ui
cat > src/client/use-export.ts <<'EOF'
import { useState } from 'react';

export function useExport() {
  const [error, setError] = useState<string | null>(null);

  async function exportCsv(range: { from?: string; to?: string }) {
    setError(null);
    const params = new URLSearchParams(range as Record<string, string>);
    const res = await fetch(`/api/invoices/export.csv?${params}`);
    if (!res.ok) return setError('Export failed. Try again in a minute.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'invoices.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return { exportCsv, error };
}
EOF
cat > src/client/ExportButton.tsx <<'EOF'
import { useExport } from './use-export';

export function ExportButton({ from, to }: { from?: string; to?: string }) {
  const { exportCsv, error } = useExport();
  return (
    <div className="export">
      <button type="button" onClick={() => exportCsv({ from, to })}>
        Export CSV
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
EOF
commit "2026-10-08T11:02:00+02:00" "feat(client): add the Export CSV button and hook"
cat > src/client/InvoicesPage.tsx <<'EOF'
import { ExportButton } from './ExportButton';
import { useInvoices } from './use-invoices';

export function InvoicesPage() {
  const { invoices, loading, range } = useInvoices();
  if (loading) return <p>Loading invoices…</p>;
  return (
    <section>
      <header className="toolbar">
        <h1>Invoices</h1>
        <ExportButton from={range.from} to={range.to} />
      </header>
      <table>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{i.customerName}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
EOF
commit "2026-10-08T16:45:00+02:00" "feat(client): show the export button on the invoices page"

git checkout -q -b export-toggle
cat > src/config/flags.ts <<'EOF'
export const flags = {
  newBillingPortal: { default: false, description: 'Stripe-hosted billing portal' },
  bulkRefunds: { default: false, description: 'Refund several invoices at once' },
  invoiceCsvExport: { default: true, description: 'Export invoices as CSV from the invoices page' },
} as const;

export type FlagCode = keyof typeof flags;
EOF
commit "2026-10-09T10:15:00+02:00" "feat(config): add the invoiceCsvExport flag"
cat > src/client/InvoicesPage.tsx <<'EOF'
import { useFlag } from '@/config/use-flag';
import { ExportButton } from './ExportButton';
import { useInvoices } from './use-invoices';

export function InvoicesPage() {
  const { invoices, loading, range } = useInvoices();
  const canExport = useFlag('invoiceCsvExport');
  if (loading) return <p>Loading invoices…</p>;
  return (
    <section>
      <header className="toolbar">
        <h1>Invoices</h1>
        {canExport && <ExportButton from={range.from} to={range.to} />}
      </header>
      <table>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{i.customerName}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
EOF
commit "2026-10-09T14:30:00+02:00" "feat(client): hide the export button behind invoiceCsvExport"

git checkout -q main
git init -q --bare -b main "$ROOT/widgets.git"
git remote add origin "$ROOT/widgets.git"
git push -q origin main
git remote set-head origin main
git log --oneline --all --graph
