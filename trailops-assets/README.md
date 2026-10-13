# TrailOps assets

This pack covers all four generated UI boards plus the splash screen (15 screen concepts total).

## Contents
- reference-screens/: original generated PNGs plus individual screen crops.
- images/: exact crops of mountains, campsite, equipment, QR camera scene, damage photo and sample avatar. Crops keep their baked-in backgrounds; they are not transparent product cutouts.
- icons/: editable Lucide SVG equivalents and sprite, not traced AI-generated pixels.
- branding/: original raster wordmark crop, editable text SVG, outlined SVG equivalent, loading dots.
- fonts/: Inter, Oswald and DM Serif Display with licenses and web font files. These are suitable implementation equivalents, not recoverable original font layers or verified Indiahikes fonts.
- design-system/: proposed JSON/TypeScript tokens and self-hosted font CSS.
- illustrations/: scope note; no standalone illustrations existed in the source screens.
- preview.html: local asset catalogue, opens without a server.
- manifest.json: per-file provenance, crop coordinates and hashes.

## Fidelity
Generated PNGs have no source layers. Exact images are supplied as original PNGs and crops. SVG branding and icons and font choices are editable equivalents. Do not claim this is an official Indiahikes asset kit. Source UI boards vary slightly in typography and mock data; the implementation tokens standardize the proposed design.

The sample QR in the generated camera scene is visual only; generate real equipment QR codes from your actual IDs. Sample avatar and gear photographs are AI-generated raster imagery. Embedded gear marks and names are not verified product branding. No authentic Google or Indiahikes identity assets are supplied; use provider-approved sign-in assets and authorized company marks if needed. Use the independent-concept label when presenting this POC.

## React Native
Bundle the TTF files, render icons with react-native-svg or lucide-react-native, and use the JSON/TypeScript tokens. Keep scanned equipment IDs separate from decorative QR imagery. SVG live text may need conversion to paths on mobile; the outlined wordmark is supplied for that purpose.
