import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { encodeEquipmentLabel } from '@trailops/contracts';
import { Button, Callout, Dialog } from '../../ui/kit';

export async function labelSvg(itemId: string): Promise<string> {
  return QRCode.toString(encodeEquipmentLabel(itemId), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 220 });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Real, scannable label generated from the stored entity id (spec §12). Carries no personal data. */
export function QrLabelDialog({ itemId, tag, subtitle, onClose }: { itemId: string; tag: string; subtitle: string; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payload = encodeEquipmentLabel(itemId);
  useEffect(() => {
    labelSvg(itemId).then(setSvg, (e) => setError(String(e)));
  }, [itemId]);

  const print = () => {
    if (!svg) return;
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>${escapeHtml(tag)} label</title><style>
      body{font-family:Inter,Arial,sans-serif;margin:0;display:flex;justify-content:center;padding:16px}
      .label{border:1px dashed #999;padding:12px 16px;text-align:center;width:240px}
      .tag{font-size:28px;font-weight:800;letter-spacing:.02em;margin-top:4px}
      .sub{font-size:12px;color:#444}
      .p{font-size:8px;color:#666;word-break:break-all;margin-top:6px}
      @media print{.label{border:none}}
    </style></head><body><div class="label">${svg}<div class="tag">${escapeHtml(tag)}</div><div class="sub">${escapeHtml(subtitle)}</div><div class="p">${escapeHtml(payload)}</div></div>
    <script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  };

  return (
    <Dialog
      title={`QR label · ${tag}`}
      description="Generated from this item's server id. The label identifies the asset only — it carries no personal data or authority."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Printer size={18} aria-hidden />} onClick={print} disabled={!svg}>
            Print label
          </Button>
        </>
      }
    >
      {error && <Callout tone="error">{error}</Callout>}
      <div className="qr-label">
        {svg ? (
          <div className="qr-svg" role="img" aria-label={`QR code for ${tag}`} dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="qr-svg qr-placeholder" />
        )}
        <div className="qr-tag">{tag}</div>
        <div className="muted small">{subtitle}</div>
        <code className="qr-payload">{payload}</code>
      </div>
    </Dialog>
  );
}
