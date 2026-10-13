// M0 compatibility spike: proves the native stack builds and persists across restarts.
import React, {useEffect, useState} from 'react';
import {Button, SafeAreaView, Text, View} from 'react-native';
import {Database, Model, appSchema, tableSchema} from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import {field} from '@nozbe/watermelondb/decorators';
import * as Keychain from 'react-native-keychain';
import {Camera, useCameraPermission} from 'react-native-vision-camera';
import ReactNativeBlobUtil from 'react-native-blob-util';

class Probe extends Model {
  static table = 'probes';
  @field('note') note!: string;
}
const db = new Database({
  adapter: new SQLiteAdapter({
    schema: appSchema({version: 1, tables: [tableSchema({name: 'probes', columns: [{name: 'note', type: 'string'}]})]}),
    dbName: 'spike',
    jsi: false,
  }),
  modelClasses: [Probe],
});

export default function SpikeApp() {
  const [count, setCount] = useState<number | null>(null);
  const [kc, setKc] = useState('…');
  const [hash, setHash] = useState('…');
  const {hasPermission, requestPermission} = useCameraPermission();
  const refresh = async () => setCount(await db.get('probes').query().fetchCount());
  useEffect(() => {
    refresh();
    Keychain.getSupportedBiometryType()
      .then(() => Keychain.setGenericPassword('spike', 'ok', {service: 'spike'}))
      .then(() => Keychain.getGenericPassword({service: 'spike'}))
      .then(r => setKc(r ? 'keychain ok' : 'keychain empty'))
      .catch(e => setKc('keychain error ' + e));
    const p = ReactNativeBlobUtil.fs.dirs.DocumentDir + '/spike.txt';
    ReactNativeBlobUtil.fs.writeFile(p, 'hello', 'utf8')
      .then(() => ReactNativeBlobUtil.fs.hash(p, 'sha256'))
      .then(setHash)
      .catch(e => setHash('fs error ' + e));
  }, []);
  return (
    <SafeAreaView>
      <View style={{padding: 24, gap: 12}}>
        <Text testID="count">rows: {String(count)}</Text>
        <Text>{kc}</Text>
        <Text>sha256: {hash.slice(0, 16)}</Text>
        <Text>camera devices: {Camera.getAvailableCameraDevices().length} permission: {String(hasPermission)}</Text>
        <Button title="Write row" onPress={async () => {
          await db.write(async () => { await db.get<Probe>('probes').create(r => { r.note = String(Date.now()); }); });
          refresh();
        }} />
        <Button title="Camera permission" onPress={requestPermission} />
      </View>
    </SafeAreaView>
  );
}
