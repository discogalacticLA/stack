/**
 * SYNTHETIC DEMO DATA. Every artist, label, release, catalog number and identifier below is
 * invented for this prototype. Any resemblance to real releases is coincidental.
 */

export interface SeedEdition {
  key: string;
  label: string | null;
  catno: string | null;
  format: string;
  details?: string;
  country: string | null;
  year: number | null;
  month?: number;
  day?: number;
  dateNote?: string;
  notes?: string;
  status: "unverified" | "sourced" | "reviewed" | "disputed";
  tracks: [string, string, string?, string?][]; // position, title, duration, artist credit
  identifiers?: [string, string, string?][];
  sources?: [string, string][];
  images?: ("front" | "back" | "label")[];
  companies?: [string, string][]; // role, company name
  credits?: [string, string][];   // role, artist name
}

export interface SeedRelease {
  title: string;
  type: "album" | "ep" | "single" | "compilation" | "other";
  artists: [string, string?][]; // name, join text
  genres: string[];
  styles: string[];
  description?: string;
  editions: SeedEdition[];
}

export const ARTISTS: Record<string, string> = {
  "Aurelia Kaan": "Kaan, Aurelia",
  "The Low Hours": "Low Hours, The",
  "Dembe Salt": "Salt, Dembe",
  "Kovač Unit": "Kovač Unit",
  "Hanae Sorell": "Sorell, Hanae",
  "Midnight Tram Ensemble": "Midnight Tram Ensemble",
  "Paz Olvera": "Olvera, Paz",
  "Glasshouse Relay": "Glasshouse Relay",
  "Idris Vale": "Vale, Idris",
  "Nocturne Assembly": "Nocturne Assembly",
  Tomo: "Tomo",
  Bex: "Bex",
  "Lua Ferreira": "Ferreira, Lua",
};

const nightbusTracks: SeedEdition["tracks"] = [
  ["A1", "Nightbus Dialogues", "6:48"],
  ["A2", "Last Stop Blue", "5:30"],
  ["B1", "Vauxhall Hum", "7:02"],
  ["B2", "Dialogues (Dub)", "6:10"],
];

export const RELEASES: SeedRelease[] = [
  {
    title: "Nightbus Dialogues",
    type: "ep",
    artists: [["Aurelia Kaan"]],
    genres: ["Electronic"],
    styles: ["Deep House", "Garage"],
    description: "Synthetic demo release. Several editions with near-identical catalog numbers — compare carefully.",
    editions: [
      {
        key: "nb-orig", label: "Lowlight Recordings", catno: "LLR-004", format: "Vinyl", details: '12", 33 ⅓ RPM', country: "UK", year: 1997, month: 3,
        notes: "Black labels with silver print. Plain black die-cut sleeve with a round sticker.", status: "reviewed", tracks: nightbusTracks,
        identifiers: [["Matrix / Runout", "LLR-004-A  ◇ LOW ◇", "side A, etched"], ["Matrix / Runout", "LLR-004-B", "side B, etched"], ["Label Code", "LC 0000 (synthetic)"]],
        sources: [["physical_copy", "Demo contributor examined a copy (synthetic source)"], ["label_statement", "Lowlight release sheet, 1997 (synthetic)"]],
        images: ["front", "label"],
        companies: [["Pressed By", "Sample Pressing Plant (synthetic)"], ["Mastered At", "Demo Mastering Room (synthetic)"]],
        credits: [["Producer", "Aurelia Kaan"], ["Mastered By", "Idris Vale"]],
      },
      {
        key: "nb-repress", label: "Lowlight Recordings", catno: "LLR-004R", format: "Vinyl", details: '12", 33 ⅓ RPM, Repress', country: "UK", year: 2004,
        dateNote: "Sleeve sticker says 2004; runout suggests the plates were cut in late 2003.",
        notes: "Grey labels. B1 is a shorter edit and B2 is replaced by a remix.", status: "sourced",
        tracks: [["A1", "Nightbus Dialogues", "6:48"], ["A2", "Last Stop Blue", "5:30"], ["B1", "Vauxhall Hum (Edit)", "5:12"], ["B2", "Nightbus Dialogues (Kovač Unit Remix)", "7:40", "Kovač Unit"]],
        identifiers: [["Matrix / Runout", "LLR-004R-A", "side A"], ["Matrix / Runout", "LLR-004R-B RE", "side B"]],
        sources: [["physical_copy", "Seller photo of runout (synthetic source)"]],
        images: ["front"],
      },
      {
        key: "nb-cd", label: "Lowlight Recordings", catno: "LLR 004 CD", format: "CD", details: "EP, Enhanced", country: "UK", year: 1997, month: 5,
        notes: "Adds a bonus track not on the vinyl.", status: "unverified",
        tracks: [["1", "Nightbus Dialogues", "6:48"], ["2", "Last Stop Blue", "5:30"], ["3", "Vauxhall Hum", "7:02"], ["4", "Dialogues (Dub)", "6:10"], ["5", "Night Service (Bonus)", "4:22"]],
        identifiers: [["Barcode", "0 00000 00404 2 (synthetic)"]],
        images: ["front"],
      },
      {
        key: "nb-tp", label: null, catno: "LLR-004 TP", format: "Vinyl", details: '12", Test Pressing, White label', country: null, year: null,
        dateNote: "Undated. Hand-written catalog number; plant unknown.",
        notes: "Handwritten white labels. Track order may differ; unconfirmed.", status: "unverified",
        tracks: [["A", "Nightbus Dialogues"], ["B", "Vauxhall Hum"]],
      },
    ],
  },
  {
    title: "Tidal Rooms",
    type: "ep",
    artists: [["The Low Hours"]],
    genres: ["Electronic"],
    styles: ["Deep House", "Dub Techno"],
    description: "Synthetic demo release. Its US catalog number LLR-04 is easy to confuse with Lowlight's LLR-004.",
    editions: [
      {
        key: "tr-us", label: "Lowline Records", catno: "LLR-04", format: "Vinyl", details: '12", 45 RPM', country: "US", year: 1998,
        notes: "Different label (Lowline, US) from Lowlight (UK). Blue labels.", status: "reviewed",
        tracks: [["A", "Tidal Rooms", "8:12"], ["B1", "Undertow", "6:01"], ["B2", "Undertow (Beats)", "3:40"]],
        companies: [["Pressed By", "Sample Pressing Plant (synthetic)"]],
        identifiers: [["Matrix / Runout", "LLR-04-A  MASTERED BY H.S.", "side A"]],
        sources: [["physical_copy", "Moderator examined a copy (synthetic source)"]],
        images: ["front"],
      },
      {
        key: "tr-de", label: "Heliotrope Audio", catno: "HEL 012", format: "Vinyl", details: '12", 33 ⅓ RPM, Licensed', country: "Germany", year: 1999,
        status: "sourced", tracks: [["A", "Tidal Rooms", "8:12"], ["B", "Undertow", "6:01"]],
        sources: [["publication", "Synthetic distributor catalog, 1999"]], images: ["front"],
      },
    ],
  },
  {
    title: "Salt Garden",
    type: "album",
    artists: [["Dembe Salt"]],
    genres: ["Jazz", "Electronic"],
    styles: ["Broken Beat", "Soul-Jazz"],
    description: "Synthetic demo album that crosses into jazz, showing the schema is not limited to house.",
    editions: [
      {
        key: "sg-lp", label: "Tidewater Tapes", catno: "TWT-11", format: "Vinyl", details: '2×LP, Gatefold', country: "US", year: 2001, month: 9, status: "reviewed",
        tracks: [["A1", "Salt Garden", "5:55"], ["A2", "Mangrove", "4:48"], ["B1", "Low Tide Samba", "6:20"], ["C1", "Brine", "7:05"], ["D1", "Garden Reprise", "3:10"]],
        identifiers: [["Barcode", "0 00000 01111 1 (synthetic)"]], sources: [["artist_statement", "Artist liner note (synthetic)"]], images: ["front", "back"],
      },
      {
        key: "sg-cd", label: "Tidewater Tapes", catno: "TWT-11CD", format: "CD", details: "Album", country: "US", year: 2001, month: 9, status: "sourced",
        notes: "CD has two extra tracks and a different running order.",
        tracks: [["1", "Mangrove", "4:48"], ["2", "Salt Garden", "5:55"], ["3", "Low Tide Samba", "6:20"], ["4", "Brine", "7:05"], ["5", "Coral Line", "5:01"], ["6", "Sea Glass", "4:40"], ["7", "Garden Reprise", "3:10"]],
        sources: [["website", "Synthetic label archive page"]], images: ["front"],
      },
      {
        key: "sg-re", label: "Tidewater Tapes", catno: "TWT-11RE", format: "Vinyl", details: "2×LP, Reissue, Remastered", country: "US", year: 2019, status: "unverified",
        tracks: [["A1", "Salt Garden", "5:55"], ["A2", "Mangrove", "4:48"], ["B1", "Low Tide Samba", "6:20"], ["C1", "Brine", "7:05"], ["D1", "Garden Reprise", "3:10"], ["D2", "Coral Line", "5:01"]],
        images: ["front"],
      },
    ],
  },
  {
    title: "Unit Theory",
    type: "ep",
    artists: [["Kovač Unit"]],
    genres: ["Electronic"],
    styles: ["Techno", "Dub Techno"],
    editions: [{ key: "ut", label: "Basement Signal", catno: "BSG-007", format: "Vinyl", details: '12"', country: "Germany", year: 2003, status: "sourced", tracks: [["A", "Theory One", "7:30"], ["B1", "Theory Two", "6:45"], ["B2", "Loop Study", "3:20"]], sources: [["physical_copy", "Synthetic source"]], images: ["front"] }],
  },
  {
    title: "Soft Machines at Dawn",
    type: "ep",
    artists: [["Hanae Sorell"]],
    genres: ["Electronic"],
    styles: ["Ambient", "Balearic"],
    editions: [
      { key: "sm", label: "Heliotrope Audio", catno: "HEL-021", format: "Vinyl", details: '12", Clear vinyl', country: "Japan", year: 2010, status: "reviewed", companies: [["Mastered At", "Demo Mastering Room (synthetic)"]], tracks: [["A1", "Soft Machines", "9:10"], ["B1", "At Dawn", "8:02"]], sources: [["physical_copy", "Synthetic source"]], images: ["front"] },
      { key: "sm-file", label: "Heliotrope Audio", catno: "HEL-021D", format: "File", details: "FLAC", country: null, year: 2010, status: "unverified", tracks: [["1", "Soft Machines", "9:10"], ["2", "At Dawn", "8:02"], ["3", "At Dawn (Beatless)", "8:40"]], images: ["front"] },
    ],
  },
  {
    title: "Tram Lines",
    type: "single",
    artists: [["Midnight Tram Ensemble"]],
    genres: ["Electronic"],
    styles: ["House", "Disco"],
    editions: [{ key: "tl", label: "Cobalt Room", catno: "CBR-001", format: "Vinyl", details: '12", 45 RPM', country: "Netherlands", year: 1995, status: "sourced", notes: "No archive image contributed yet.", tracks: [["A", "Tram Lines", "6:30"], ["B", "Tram Lines (Late Service)", "7:15"]], sources: [["publication", "Synthetic fanzine review, 1995"]] }],
  },
  {
    title: "Olvera Tapes Vol. 1",
    type: "compilation",
    artists: [["Paz Olvera"]],
    genres: ["Electronic"],
    styles: ["Ambient", "Experimental"],
    description: "Self-released cassette with very little documented information.",
    editions: [{ key: "ot", label: null, catno: null, format: "Cassette", details: "C60, Self-released", country: "Mexico", year: null, dateNote: "Believed to be early 1990s; no date on the inlay.", status: "unverified", tracks: [] }],
  },
  {
    title: "Relay / Return",
    type: "single",
    artists: [["Glasshouse Relay"]],
    genres: ["Electronic"],
    styles: ["Techno"],
    editions: [{ key: "rr", label: "Basement Signal", catno: "BSG-012", format: "Vinyl", details: '12"', country: "Germany", year: 2005, status: "sourced", tracks: [["A", "Relay", "6:50"], ["B", "Return", "6:35"]], sources: [["physical_copy", "Synthetic source"]], images: ["front"] }],
  },
  {
    title: "Vale",
    type: "album",
    artists: [["Idris Vale"]],
    genres: ["Electronic"],
    styles: ["Deep House", "Broken Beat"],
    editions: [{ key: "va", label: "Heliotrope Audio", catno: "HEL-030", format: "Vinyl", details: "LP", country: "UK", year: 2012, status: "reviewed", tracks: [["A1", "Valley", "5:12"], ["A2", "Glassline", "6:01"], ["B1", "Hollow", "5:44"], ["B2", "Vale", "7:20"]], sources: [["label_statement", "Synthetic label statement"]], images: ["front", "back"] }],
  },
  {
    title: "Assembly Hall",
    type: "ep",
    artists: [["Nocturne Assembly"]],
    genres: ["Electronic"],
    styles: ["House", "Garage"],
    editions: [{ key: "ah", label: "Cobalt Room", catno: "CBR-009", format: "Vinyl", details: '12"', country: "Netherlands", year: 1999, status: "sourced", tracks: [["A1", "Assembly Hall", "6:40"], ["B1", "Choir Loft", "6:10"], ["B2", "Hall Dub", "5:50"]], sources: [["physical_copy", "Synthetic source"]], images: ["front"] }],
  },
  {
    title: "Warm Up Tools Vol. 2",
    type: "ep",
    artists: [["Tomo", " & "], ["Bex"]],
    genres: ["Electronic"],
    styles: ["Deep House", "House"],
    editions: [{ key: "wt", label: "Lowlight Recordings", catno: "LLR-022", format: "Vinyl", details: '12"', country: "UK", year: 2008, status: "reviewed", tracks: [["A1", "Tool One", "5:30"], ["A2", "Tool Two", "5:02"], ["B1", "Tool Three", "6:15"], ["B2", "Tool Four", "4:48"]], sources: [["physical_copy", "Synthetic source"]], images: ["front"] }],
  },
  {
    title: "Deep Weather",
    type: "album",
    artists: [["Aurelia Kaan"]],
    genres: ["Electronic"],
    styles: ["Deep House", "Ambient"],
    editions: [
      { key: "dw", label: "Lowlight Recordings", catno: "LLR-011", format: "Vinyl", details: "2×LP", country: "UK", year: 2000, status: "reviewed", tracks: [["A1", "Front", "6:00"], ["B1", "Pressure", "6:30"], ["C1", "Squall", "7:10"], ["D1", "Clearing", "5:50"]], sources: [["label_statement", "Synthetic release sheet"]], images: ["front"] },
      { key: "dw-cd", label: "Lowlight Recordings", catno: "LLR-011CD", format: "CD", country: "UK", year: 2000, status: "sourced", tracks: [["1", "Front", "6:00"], ["2", "Pressure", "6:30"], ["3", "Squall", "7:10"], ["4", "Clearing", "5:50"], ["5", "Isobar", "6:44"]], sources: [["website", "Synthetic source"]], images: ["front"] },
    ],
  },
  {
    title: "Mar Aberto",
    type: "ep",
    artists: [["Lua Ferreira"]],
    genres: ["Electronic", "Latin"],
    styles: ["Balearic", "Disco"],
    editions: [{ key: "ma", label: "Tidewater Tapes", catno: "TWT-30", format: "Vinyl", details: '12"', country: "Brazil", year: 2016, status: "sourced", tracks: [["A", "Mar Aberto", "7:02"], ["B", "Mar Aberto (Instrumental)", "7:00"]], sources: [["artist_statement", "Synthetic source"]], images: ["front"] }],
  },
];
