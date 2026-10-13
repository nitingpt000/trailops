import { useState } from 'react';
import { useCamps, useCategories } from '../../api/queries';
import { useCommand } from '../../api/useCommand';
import { useSession } from '../../app/session';
import { Button, Dialog, ReceiptNotice, Select, TextArea, TextInput } from '../../ui/kit';

const TAG = /^[A-Z]{2,4}-\d{3,4}$/;

export function AddEquipmentDialog({ onClose }: { onClose: () => void }) {
  const { camp } = useSession();
  const camps = useCamps();
  const categories = useCategories();
  // The new item's id is minted once per dialog so a retried submission cannot create two items.
  const [itemId] = useState(() => crypto.randomUUID());
  const [tag, setTag] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [size, setSize] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const cmd = useCommand({ success: (r) => `${String(r.data?.tag ?? tag)} added as Ready`, onAccepted: onClose });
  const locations = camps.data?.find((c) => c.id === camp?.id)?.locations ?? [];
  const normalized = tag.trim().toUpperCase();
  const tagError = touched && !TAG.test(normalized) ? 'Use a tag like JKT-014 (2–4 letters, dash, 3–4 digits).' : null;
  const fe = cmd.outcome?.fieldErrors ?? {};
  const valid = TAG.test(normalized) && categoryId && locationId;

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    void cmd.submit({
      type: 'EQUIPMENT_CREATE',
      aggregate_id: itemId,
      payload: {
        category_id: categoryId,
        tag: normalized,
        location_id: locationId,
        ...(size.trim() ? { size: size.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
    });
  };

  return (
    <Dialog
      title="Add equipment"
      description={`New items start as Ready at a location in ${camp?.name ?? 'the selected camp'}. Each row is one tagged asset; a pole pair is one asset.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" pending={cmd.pending} onClick={submit} disabled={touched && !valid}>
            Add equipment
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextInput
          label="Tag"
          required
          value={tag}
          onChange={(e) => setTag(e.target.value.toUpperCase())}
          onBlur={() => setTouched(true)}
          placeholder="JKT-031"
          maxLength={9}
          error={tagError ?? fe.tag}
          hint="Printed on the item. Must be unique in the organisation."
        />
        <Select label="Category" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)} error={(touched && !categoryId ? 'Choose a category' : null) ?? fe.category_id}>
          <option value="">Choose…</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.unit})
            </option>
          ))}
        </Select>
        <Select label="Location" required value={locationId} onChange={(e) => setLocationId(e.target.value)} error={(touched && !locationId ? 'Choose a location' : null) ?? fe.location_id}>
          <option value="">Choose…</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </Select>
        <TextInput label="Size" value={size} onChange={(e) => setSize(e.target.value)} maxLength={40} placeholder="M, 9, 60L…" error={fe.size} />
        <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} error={fe.notes} />
        <button type="submit" hidden />
      </form>
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}
