/**
 * Renders a published form version (spec §17). Only the declarative schema is interpreted; no code is
 * ever executed from a form definition. Visibility/required rules come from @trailops/contracts, the
 * same engine the console preview uses and that is fixture-tested against the server's.
 */
import React, {useState} from 'react';
import {Image, Pressable, Text, View} from 'react-native';
import {Camera as CameraIcon, X} from 'lucide-react-native';
import {isRequired, optionLabel, visibleFields, type FormField, type FormSchema} from '@trailops/contracts';
import {Choice, Field, Input, Row, Sheet} from '../../ui/components';
import {colors, radius, space, type} from '../../ui/tokens';
import type {CapturedPhoto} from '../../sync/attachments';

export function FormRenderer({
  schema, answers, onChange, errors, photos, onAddPhoto, onRemovePhoto, equipmentLabel,
}: {
  schema: FormSchema;
  answers: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  errors: Record<string, string>;
  photos: Record<string, CapturedPhoto[]>;
  onAddPhoto: (fieldId: string) => void;
  onRemovePhoto: (fieldId: string, attachmentId: string) => void;
  equipmentLabel: string;
}) {
  const fields = visibleFields(schema, answers);
  return (
    <View style={{gap: space.l}}>
      {fields.map(f => (
        <FieldInput key={f.id} f={f} value={answers[f.id]} onChange={v => onChange(f.id, v)}
          required={isRequired(f, answers)} error={errors[f.id]} photos={photos[f.id] ?? []}
          onAddPhoto={() => onAddPhoto(f.id)} onRemovePhoto={id => onRemovePhoto(f.id, id)} equipmentLabel={equipmentLabel} />
      ))}
    </View>
  );
}

function FieldInput({f, value, onChange, required, error, photos, onAddPhoto, onRemovePhoto, equipmentLabel}: {
  f: FormField; value: unknown; onChange: (v: unknown) => void; required: boolean; error?: string;
  photos: CapturedPhoto[]; onAddPhoto: () => void; onRemovePhoto: (id: string) => void; equipmentLabel: string;
}) {
  const label = `${f.label ?? f.id}${required ? ' *' : ' (optional)'}`;
  const [open, setOpen] = useState(false);
  switch (f.type) {
    case 'equipment_ref':
      return <Field label={label}><Text style={[type.body, {fontWeight: '600'}]}>{equipmentLabel}</Text></Field>;
    case 'select': {
      const opts = (f.options ?? []).map(o => ({value: o, label: optionLabel(f, o)}));
      if (opts.length <= 4) {
        return <Field label={label} error={error}><Choice testIDPrefix={`field-${f.id}`} options={opts} value={value as string} onChange={onChange} /></Field>;
      }
      return (
        <Field label={label} error={error}>
          <Pressable testID={`field-${f.id}`} accessibilityRole="button" onPress={() => setOpen(true)}
            style={{borderWidth: 1, borderColor: '#D0D5DD', borderRadius: radius.input, minHeight: 48, justifyContent: 'center', paddingHorizontal: space.m}}>
            <Text style={type.body}>{value ? optionLabel(f, value as string) : 'Choose…'}</Text>
          </Pressable>
          <Sheet visible={open} onClose={() => setOpen(false)} title={f.label ?? f.id}>
            {opts.map(o => <Row key={o.value} testID={`option-${o.value}`} title={o.label} onPress={() => { onChange(o.value); setOpen(false); }} />)}
          </Sheet>
        </Field>
      );
    }
    case 'boolean':
      return <Field label={label} error={error}><Choice options={[{value: 'true', label: 'Yes'}, {value: 'false', label: 'No'}]}
        value={value === undefined ? undefined : String(value)} onChange={v => onChange(v === 'true')} /></Field>;
    case 'text':
    case 'textarea': {
      const text = (value as string) ?? '';
      const max = f.max_length ?? 2000;
      return (
        <Field label={label} error={error} hint={`${text.length}/${max}`}>
          <Input testID={`field-${f.id}`} value={text} onChangeText={onChange} multiline={f.type === 'textarea'} maxLength={max}
            placeholder={f.placeholder} accessibilityLabel={f.label ?? f.id} />
        </Field>
      );
    }
    case 'integer':
    case 'decimal':
      return (
        <Field label={label} error={error}>
          <Input keyboardType="numeric" value={value === undefined ? '' : String(value)}
            onChangeText={t => onChange(t === '' ? undefined : f.type === 'integer' ? parseInt(t, 10) : parseFloat(t))} />
        </Field>
      );
    case 'date':
      return <Field label={label} error={error} hint="YYYY-MM-DD"><Input value={(value as string) ?? ''} onChangeText={onChange} /></Field>;
    case 'photo':
      return (
        <Field label={label} error={error} hint="Photos are saved on this device and upload when connected.">
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: space.m}}>
            {photos.map(p => (
              <View key={p.attachment_id}>
                <Image source={{uri: `file://${p.path}`}} style={{width: 100, height: 100, borderRadius: 8}} accessibilityLabel="Captured photo" />
                <Pressable accessibilityRole="button" accessibilityLabel="Remove photo" onPress={() => onRemovePhoto(p.attachment_id)}
                  style={{position: 'absolute', top: -8, right: -8, backgroundColor: colors.text, borderRadius: 14, width: 28, height: 28, alignItems: 'center', justifyContent: 'center'}}>
                  <X color="#fff" size={16} />
                </Pressable>
              </View>
            ))}
            {photos.length < (f.max_count ?? 1) ? (
              <Pressable testID={`add-photo-${f.id}`} accessibilityRole="button" onPress={onAddPhoto}
                style={{width: 100, height: 100, borderRadius: 8, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.muted, alignItems: 'center', justifyContent: 'center', gap: 4}}>
                <CameraIcon color={colors.text} size={24} />
                <Text style={type.small}>Add photo</Text>
              </Pressable>
            ) : null}
          </View>
        </Field>
      );
  }
  return null;
}
