/**
 * HTML character reference decoding for text content, following the HTML
 * parsing rules: named references with a semicolon, the legacy names that
 * also decode without one (`&amp`, `&nbsp`), and decimal or hexadecimal
 * references. Named references cover the HTML 4 set; any other name is left
 * as written.
 */

const NAMED = new Map<string, string>(
  (
    "aacute:225 Aacute:193 acirc:226 Acirc:194 acute:180 aelig:230 AElig:198 agrave:224 " +
    "Agrave:192 alefsym:8501 alpha:945 Alpha:913 amp:38 AMP:38 and:8743 ang:8736 apos:39 " +
    "aring:229 Aring:197 asymp:8776 atilde:227 Atilde:195 auml:228 Auml:196 bdquo:8222 " +
    "beta:946 Beta:914 brvbar:166 bull:8226 cap:8745 ccedil:231 Ccedil:199 cedil:184 " +
    "cent:162 chi:967 Chi:935 circ:710 clubs:9827 cong:8773 copy:169 COPY:169 crarr:8629 " +
    "cup:8746 curren:164 dagger:8224 Dagger:8225 darr:8595 dArr:8659 deg:176 delta:948 " +
    "Delta:916 diams:9830 divide:247 eacute:233 Eacute:201 ecirc:234 Ecirc:202 egrave:232 " +
    "Egrave:200 empty:8709 emsp:8195 ensp:8194 epsilon:949 Epsilon:917 equiv:8801 eta:951 " +
    "Eta:919 eth:240 ETH:208 euml:235 Euml:203 euro:8364 exist:8707 fnof:402 forall:8704 " +
    "frac12:189 frac14:188 frac34:190 frasl:8260 gamma:947 Gamma:915 ge:8805 gt:62 GT:62 " +
    "harr:8596 hArr:8660 hearts:9829 hellip:8230 iacute:237 Iacute:205 icirc:238 " +
    "Icirc:206 iexcl:161 igrave:236 Igrave:204 image:8465 infin:8734 int:8747 iota:953 " +
    "Iota:921 iquest:191 isin:8712 iuml:239 Iuml:207 kappa:954 Kappa:922 lambda:955 " +
    "Lambda:923 lang:10216 laquo:171 larr:8592 lArr:8656 lceil:8968 ldquo:8220 le:8804 " +
    "lfloor:8970 lowast:8727 loz:9674 lrm:8206 lsaquo:8249 lsquo:8216 lt:60 LT:60 " +
    "macr:175 mdash:8212 micro:181 middot:183 minus:8722 mu:956 Mu:924 nabla:8711 " +
    "nbsp:160 ndash:8211 ne:8800 ni:8715 not:172 notin:8713 nsub:8836 ntilde:241 " +
    "Ntilde:209 nu:957 Nu:925 oacute:243 Oacute:211 ocirc:244 Ocirc:212 oelig:339 " +
    "OElig:338 ograve:242 Ograve:210 oline:8254 omega:969 Omega:937 omicron:959 " +
    "Omicron:927 oplus:8853 or:8744 ordf:170 ordm:186 oslash:248 Oslash:216 otilde:245 " +
    "Otilde:213 otimes:8855 ouml:246 Ouml:214 para:182 part:8706 permil:8240 perp:8869 " +
    "phi:966 Phi:934 pi:960 Pi:928 piv:982 plusmn:177 pound:163 prime:8242 Prime:8243 " +
    "prod:8719 prop:8733 psi:968 Psi:936 quot:34 QUOT:34 radic:8730 rang:10217 raquo:187 " +
    "rarr:8594 rArr:8658 rceil:8969 rdquo:8221 real:8476 reg:174 REG:174 rfloor:8971 " +
    "rho:961 Rho:929 rlm:8207 rsaquo:8250 rsquo:8217 sbquo:8218 scaron:353 Scaron:352 " +
    "sdot:8901 sect:167 shy:173 sigma:963 Sigma:931 sigmaf:962 sim:8764 spades:9824 " +
    "sub:8834 sube:8838 sum:8721 sup:8835 sup1:185 sup2:178 sup3:179 supe:8839 szlig:223 " +
    "tau:964 Tau:932 there4:8756 theta:952 Theta:920 thetasym:977 thinsp:8201 thorn:254 " +
    "THORN:222 tilde:732 times:215 trade:8482 uacute:250 Uacute:218 uarr:8593 uArr:8657 " +
    "ucirc:251 Ucirc:219 ugrave:249 Ugrave:217 uml:168 upsih:978 upsilon:965 Upsilon:933 " +
    "uuml:252 Uuml:220 weierp:8472 xi:958 Xi:926 yacute:253 Yacute:221 yen:165 yuml:255 " +
    "Yuml:376 zeta:950 Zeta:918 zwj:8205 zwnj:8204"
  )
    .split(" ")
    .map((pair) => {
      const [name, code] = pair.split(":");
      return [name!, String.fromCodePoint(Number(code))];
    })
);

/** Names that also decode without a semicolon. */
const LEGACY = (
  "Aacute Agrave Atilde Ccedil Eacute Egrave Iacute Igrave Ntilde Oacute Ograve Oslash " +
  "Otilde Uacute Ugrave Yacute aacute agrave atilde brvbar ccedil curren divide eacute " +
  "egrave frac12 frac14 frac34 iacute igrave iquest middot ntilde oacute ograve oslash " +
  "otilde plusmn uacute ugrave yacute AElig Acirc Aring Ecirc Icirc Ocirc THORN Ucirc acirc " +
  "acute aelig aring cedil ecirc icirc iexcl laquo micro ocirc pound raquo szlig thorn " +
  "times ucirc Auml COPY Euml Iuml Ouml QUOT Uuml auml cent copy euml iuml macr nbsp ordf " +
  "ordm ouml para quot sect sup1 sup2 sup3 uuml yuml AMP ETH REG amp deg eth not reg shy " +
  "uml yen GT LT gt lt"
).split(" ");

/** Numeric references the HTML parser remaps (NUL and the Windows-1252 range). */
const NUMERIC_REMAP = new Map<number, number>([
  [0, 65533], [128, 8364], [130, 8218], [131, 402], [132, 8222], [133, 8230], [134, 8224],
  [135, 8225], [136, 710], [137, 8240], [138, 352], [139, 8249], [140, 338], [142, 381],
  [145, 8216], [146, 8217], [147, 8220], [148, 8221], [149, 8226], [150, 8211], [151, 8212],
  [152, 732], [153, 8482], [154, 353], [155, 8250], [156, 339], [158, 382], [159, 376]
]);

const fromCodePoint = (codePoint: number) => {
  if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) return "\ufffd";
  return String.fromCodePoint(NUMERIC_REMAP.get(codePoint) ?? codePoint);
};

const LEGACY_NAMES = new Set(LEGACY);
const LEGACY_MAX = Math.max(...LEGACY.map((name) => name.length));

/** A character reference candidate; none of its parts can backtrack into another. */
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([0-9A-Za-z]+)(;?))/g;

/** The longest legacy name starting `name`, unless it is all of `name` and a semicolon follows. */
const legacyPrefix = (name: string, semicolon: boolean) => {
  for (let length = Math.min(LEGACY_MAX, name.length); length >= 2; length--) {
    const candidate = name.substring(0, length);
    if (LEGACY_NAMES.has(candidate) && (length < name.length || !semicolon)) return candidate;
  }
  return null;
};

export const decodeEntities = (text: string): string =>
  text.replace(REFERENCE, (match, hex?: string, decimal?: string, name?: string, semi?: string) => {
    if (hex) return fromCodePoint(parseInt(hex, 16));
    if (decimal) return fromCodePoint(parseInt(decimal, 10));
    const named = semi ? NAMED.get(name!) : undefined;
    if (named !== undefined) return named;
    const legacy = legacyPrefix(name!, !!semi);
    if (legacy) return NAMED.get(legacy)! + match.substring(1 + legacy.length);
    return match;
  });
