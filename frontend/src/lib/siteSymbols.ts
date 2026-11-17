/**
 * «رمز الموقع على الخريطة» for a site (owner, 10 Nov 2026; V32, ADR-048; widened 17 Nov 2026): MIL-STD-2525C, APP-6 compatible,
 * friendly, drawn offline by the bundled milsymbol. Display only.
 * MOVER's tactical graphics and control measures (route points, checkpoints, gates, supply and fuel points: the «G…» codes)
 * are not offered — this application registers facilities and draws no operations (CLAUDE.md scope); the server refuses them.
 */
export type SiteSymbol = { key: string; label: string; category: string; sidc: string; keywords: string; en: string };

/** The picker's categories (owner brief §12, 17 Nov 2026), in the owner's order. */
export const SYMBOL_CATEGORIES: { key: string; label: string }[] = [
  { key: 'places', label: 'المواقع' },
  { key: 'command', label: 'القيادة' },
  { key: 'units', label: 'الوحدات' },
  { key: 'medical', label: 'الطبية' },
  { key: 'support', label: 'الدعم' },
  { key: 'transport', label: 'النقل' },
  { key: 'maintenance', label: 'الصيانة' },
  { key: 'signals', label: 'الاتصالات' },
  { key: 'security', label: 'الأمن' },
  { key: 'facilities', label: 'المنشآت' },
];

/**
 * The catalogue (owner brief §10, 17 Nov 2026: a wide catalogue, Arabic first): friendly MIL-STD-2525C units and installations,
 * each checked to draw with the bundled milsymbol. The codes of the earlier 15 are kept, so a saved site keeps its symbol.
 * The code is never shown to the person choosing; they search by name (lib/symbolSearch.ts).
 */
export const SITE_SYMBOLS: SiteSymbol[] = [
  // المواقع
  { key: 'base', label: 'معسكر / قاعدة', category: 'places', sidc: 'SFGPIB----H----', keywords: 'معسكر قاعدة موقع منشأة تمركز ثكنة', en: 'Base / camp' },
  { key: 'airfield', label: 'مطار / قاعدة جوية', category: 'places', sidc: 'SFGPIBA---H----', keywords: 'مطار مهبط قاعدة جوية طائرات مدرج', en: 'Airport / air base' },
  { key: 'naval_base', label: 'قاعدة بحرية / ميناء', category: 'places', sidc: 'SFGPIBN---H----', keywords: 'ميناء مرفأ رصيف بحري سفن قاعدة بحرية', en: 'Naval base / port' },
  { key: 'government', label: 'مقر حكومي', category: 'places', sidc: 'SFGPIG----H----', keywords: 'حكومة مقر رسمي وزارة إدارة عليا', en: 'Government leadership' },
  // القيادة
  { key: 'command_post', label: 'قيادة / مقر', category: 'command', sidc: 'SFGPUH---------', keywords: 'قيادة مقر مركز قيادة قائد هيئة أركان', en: 'Headquarters' },
  { key: 'admin', label: 'شؤون إدارية', category: 'command', sidc: 'SFGPUSA--------', keywords: 'إدارة شؤون إدارية أفراد سكرتارية', en: 'Administrative' },
  { key: 'personnel', label: 'شؤون الأفراد', category: 'command', sidc: 'SFGPUSAP-------', keywords: 'أفراد شؤون الأفراد موارد بشرية تجنيد', en: 'Personnel services' },
  { key: 'finance', label: 'مالية', category: 'command', sidc: 'SFGPUSAF-------', keywords: 'مالية رواتب حسابات', en: 'Finance' },
  { key: 'legal', label: 'قضاء عسكري', category: 'command', sidc: 'SFGPUSAJ-------', keywords: 'قضاء قانونية محكمة', en: 'Judge advocate' },
  { key: 'intelligence', label: 'استخبارات', category: 'command', sidc: 'SFGPUUM--------', keywords: 'استخبارات معلومات مخابرات', en: 'Military intelligence' },
  { key: 'info_ops', label: 'عمليات المعلومات', category: 'command', sidc: 'SFGPUUI--------', keywords: 'معلومات حرب إلكترونية سيبراني', en: 'Information warfare' },
  // الوحدات
  { key: 'unit', label: 'وحدة', category: 'units', sidc: 'SFGPU----------', keywords: 'وحدة عامة', en: 'Unit' },
  { key: 'infantry', label: 'مشاة', category: 'units', sidc: 'SFGPUCI--------', keywords: 'مشاة جنود راجلة', en: 'Infantry' },
  { key: 'infantry_light', label: 'مشاة خفيفة', category: 'units', sidc: 'SFGPUCIL-------', keywords: 'مشاة خفيفة', en: 'Light infantry' },
  { key: 'infantry_motorized', label: 'مشاة محمولة', category: 'units', sidc: 'SFGPUCIM-------', keywords: 'مشاة محمولة آلية عربات', en: 'Motorized infantry' },
  { key: 'infantry_mech', label: 'مشاة ميكانيكية', category: 'units', sidc: 'SFGPUCIZ-------', keywords: 'مشاة ميكانيكية آلية مدرعة', en: 'Mechanized infantry' },
  { key: 'infantry_airborne', label: 'مشاة محمولة جواً', category: 'units', sidc: 'SFGPUCIA-------', keywords: 'مظليين محمولة جوا إنزال', en: 'Airborne infantry' },
  { key: 'armor', label: 'مدرعات', category: 'units', sidc: 'SFGPUCA--------', keywords: 'مدرعات دروع دبابات آليات مدرعة', en: 'Armour' },
  { key: 'tanks', label: 'دبابات', category: 'units', sidc: 'SFGPUCAT-------', keywords: 'دبابات مدرعات دروع جنزير', en: 'Armour, tracked' },
  { key: 'armor_wheeled', label: 'مدرعات على عجلات', category: 'units', sidc: 'SFGPUCAW-------', keywords: 'مدرعات عجلات دروع', en: 'Armour, wheeled' },
  { key: 'antiarmor', label: 'مضاد للدروع', category: 'units', sidc: 'SFGPUCAA-------', keywords: 'مضاد دروع م/د صواريخ مضادة للدبابات', en: 'Anti-armour' },
  { key: 'recon', label: 'استطلاع', category: 'units', sidc: 'SFGPUCR--------', keywords: 'استطلاع استكشاف مراقبة', en: 'Reconnaissance' },
  { key: 'cavalry', label: 'استطلاع آلي', category: 'units', sidc: 'SFGPUCRV-------', keywords: 'استطلاع آلي فرسان خيالة', en: 'Cavalry' },
  { key: 'artillery', label: 'مدفعية', category: 'units', sidc: 'SFGPUCF--------', keywords: 'مدفعية مدافع ميدان', en: 'Field artillery' },
  { key: 'howitzer', label: 'مدفعية هاوتزر', category: 'units', sidc: 'SFGPUCFH-------', keywords: 'هاوتزر مدافع ذاتية', en: 'Howitzer' },
  { key: 'rocket', label: 'راجمات صواريخ', category: 'units', sidc: 'SFGPUCFR-------', keywords: 'راجمات صواريخ', en: 'Rocket artillery' },
  { key: 'mortar', label: 'هاون', category: 'units', sidc: 'SFGPUCFM-------', keywords: 'هاون مدفعية خفيفة', en: 'Mortar' },
  { key: 'air_defense', label: 'دفاع جوي', category: 'units', sidc: 'SFGPUCD--------', keywords: 'دفاع جوي مضاد للطائرات', en: 'Air defence' },
  { key: 'air_defense_missile', label: 'دفاع جوي صاروخي', category: 'units', sidc: 'SFGPUCDM-------', keywords: 'دفاع جوي صواريخ أرض جو', en: 'Air defence missile' },
  { key: 'air_defense_gun', label: 'مدفعية مضادة للطائرات', category: 'units', sidc: 'SFGPUCDG-------', keywords: 'مضاد للطائرات م/ط مدفعية', en: 'Air defence gun' },
  { key: 'missile', label: 'صواريخ', category: 'units', sidc: 'SFGPUCM--------', keywords: 'صواريخ أرض أرض', en: 'Missile' },
  { key: 'aviation', label: 'طيران', category: 'units', sidc: 'SFGPUCV--------', keywords: 'طيران طائرات', en: 'Aviation' },
  { key: 'helicopter', label: 'طيران عمودي', category: 'units', sidc: 'SFGPUCVR-------', keywords: 'مروحيات هليكوبتر طيران عمودي', en: 'Rotary wing' },
  { key: 'fixed_wing', label: 'طيران ثابت الجناح', category: 'units', sidc: 'SFGPUCVF-------', keywords: 'طائرات ثابتة الجناح', en: 'Fixed wing' },
  { key: 'uav', label: 'طائرات بدون طيار', category: 'units', sidc: 'SFGPUCVU-------', keywords: 'درون بدون طيار مسيرة', en: 'Unmanned aerial' },
  { key: 'engineer', label: 'هندسة', category: 'units', sidc: 'SFGPUCE--------', keywords: 'هندسة مهندسين تحصين حفر', en: 'Engineer' },
  { key: 'combat_engineer', label: 'هندسة قتالية', category: 'units', sidc: 'SFGPUCEC-------', keywords: 'هندسة قتالية ألغام فتح ثغرات', en: 'Combat engineer' },
  { key: 'construction', label: 'هندسة إنشاءات', category: 'units', sidc: 'SFGPUCEN-------', keywords: 'إنشاءات بناء تشييد', en: 'Construction engineer' },
  { key: 'cbrn', label: 'دفاع كيميائي', category: 'units', sidc: 'SFGPUUA--------', keywords: 'كيماوي كيميائي نووي إشعاعي بيولوجي دفاع', en: 'CBRN defence' },
  { key: 'eod', label: 'إبطال متفجرات', category: 'units', sidc: 'SFGPUUE--------', keywords: 'متفجرات تفكيك إبطال ذخائر', en: 'Explosive ordnance disposal' },
  { key: 'topographic', label: 'مساحة وطبوغرافيا', category: 'units', sidc: 'SFGPUUT--------', keywords: 'مساحة طبوغرافيا خرائط', en: 'Topographic' },
  // الطبية
  { key: 'medical', label: 'طبابة', category: 'medical', sidc: 'SFGPUSM--------', keywords: 'طبابة طبي خدمات طبية علاج', en: 'Medical' },
  { key: 'medical_treatment', label: 'مركز صحي', category: 'medical', sidc: 'SFGPUSMT-------', keywords: 'مركز صحي عيادة علاج وحدة طبية', en: 'Medical treatment facility' },
  { key: 'field_hospital', label: 'مستشفى ميداني', category: 'medical', sidc: 'SFGPIXH---H----', keywords: 'مستشفى ميداني منشأة طبية', en: 'Field hospital' },
  { key: 'medical_facility', label: 'منشأة طبية', category: 'medical', sidc: 'SFGPIX----H----', keywords: 'منشأة طبية مستشفى', en: 'Medical facility' },
  { key: 'dental', label: 'طب الأسنان', category: 'medical', sidc: 'SFGPUSMD-------', keywords: 'أسنان عيادة أسنان', en: 'Dental' },
  { key: 'veterinary', label: 'بيطرة', category: 'medical', sidc: 'SFGPUSMV-------', keywords: 'بيطري حيوانات', en: 'Veterinary' },
  { key: 'psych', label: 'صحة نفسية', category: 'medical', sidc: 'SFGPUSMP-------', keywords: 'نفسي صحة نفسية', en: 'Psychological' },
  { key: 'ambulance', label: 'إسعاف', category: 'medical', sidc: 'SFGPUSMM-------', keywords: 'إسعاف نقل طبي إخلاء طبي', en: 'Medical evacuation' },
  // الدعم
  { key: 'logistics', label: 'إمداد ولوجستيات', category: 'support', sidc: 'SFGPUSS--------', keywords: 'إمداد تموين لوجستيات مستودع مخزن', en: 'Supply' },
  { key: 'food', label: 'تموين وأغذية', category: 'support', sidc: 'SFGPUSS1-------', keywords: 'أغذية تموين طعام إعاشة مطبخ', en: 'Subsistence' },
  { key: 'fuel', label: 'وقود', category: 'support', sidc: 'SFGPUSS3-------', keywords: 'وقود محروقات بترول ديزل بنزين', en: 'Fuel' },
  { key: 'ammo', label: 'ذخيرة', category: 'support', sidc: 'SFGPUSS5-------', keywords: 'ذخيرة عتاد مستودع ذخيرة', en: 'Ammunition' },
  { key: 'water', label: 'مياه', category: 'support', sidc: 'SFGPUSSW-------', keywords: 'مياه ماء تحلية', en: 'Water' },
  { key: 'labor', label: 'خدمات', category: 'support', sidc: 'SFGPUSAL-------', keywords: 'خدمات عمالة دعم', en: 'Labour' },
  { key: 'mortuary', label: 'شؤون الوفيات', category: 'support', sidc: 'SFGPUSAM-------', keywords: 'وفيات دفن', en: 'Mortuary affairs' },
  { key: 'religious', label: 'شؤون دينية', category: 'support', sidc: 'SFGPUSAR-------', keywords: 'ديني إمام مسجد', en: 'Religious' },
  // النقل
  { key: 'transport', label: 'نقل', category: 'transport', sidc: 'SFGPUST--------', keywords: 'نقل ناقلات شاحنات حركة', en: 'Transportation' },
  { key: 'movement_control', label: 'تنظيم الحركة', category: 'transport', sidc: 'SFGPUSTM-------', keywords: 'حركة تنظيم المرور سير', en: 'Movement control' },
  { key: 'rail_transport', label: 'نقل بالسكك', category: 'transport', sidc: 'SFGPUSTR-------', keywords: 'سكك حديد قطارات', en: 'Railhead' },
  { key: 'air_transport', label: 'نقل جوي', category: 'transport', sidc: 'SFGPUSTA-------', keywords: 'نقل جوي شحن جوي', en: 'Air terminal' },
  // الصيانة
  { key: 'maintenance', label: 'صيانة', category: 'maintenance', sidc: 'SFGPUSX--------', keywords: 'صيانة ورشة إصلاح', en: 'Maintenance' },
  { key: 'heavy_maintenance', label: 'صيانة ثقيلة', category: 'maintenance', sidc: 'SFGPUSXH-------', keywords: 'صيانة ثقيلة ورشة كبرى', en: 'Heavy maintenance' },
  { key: 'recovery', label: 'إخلاء واسترجاع آليات', category: 'maintenance', sidc: 'SFGPUSXR-------', keywords: 'إخلاء آليات استرجاع سحب ونش', en: 'Recovery' },
  { key: 'electro_optical', label: 'صيانة إلكترونية', category: 'maintenance', sidc: 'SFGPUSXE-------', keywords: 'صيانة إلكترونية أجهزة', en: 'Electro-optical maintenance' },
  { key: 'ordnance', label: 'صيانة أسلحة', category: 'maintenance', sidc: 'SFGPUSXO-------', keywords: 'أسلحة ذخائر صيانة تسليح', en: 'Ordnance' },
  // الاتصالات
  { key: 'signals', label: 'إشارة واتصالات', category: 'signals', sidc: 'SFGPUUS--------', keywords: 'اتصالات إشارة لاسلكي شبكة', en: 'Signal' },
  { key: 'radio', label: 'لاسلكي', category: 'signals', sidc: 'SFGPUUSR-------', keywords: 'لاسلكي راديو', en: 'Radio' },
  { key: 'comm_center', label: 'مركز اتصالات', category: 'signals', sidc: 'SFGPUUSC-------', keywords: 'مركز اتصالات بدالة', en: 'Communication configured package' },
  { key: 'radio_relay', label: 'تقوية بث', category: 'signals', sidc: 'SFGPUUSW-------', keywords: 'تقوية بث مرحل', en: 'Radio relay' },
  { key: 'telecom_facility', label: 'منشأة اتصالات', category: 'signals', sidc: 'SFGPIUT---H----', keywords: 'اتصالات أبراج شبكة منشأة', en: 'Telecommunications facility' },
  // الأمن
  { key: 'security', label: 'أمن وحراسة', category: 'security', sidc: 'SFGPUCIS-------', keywords: 'أمن حماية حراسة', en: 'Security' },
  { key: 'military_police', label: 'شرطة عسكرية', category: 'security', sidc: 'SFGPUULM-------', keywords: 'شرطة عسكرية انضباط', en: 'Military police' },
  { key: 'law_enforcement', label: 'شرطة', category: 'security', sidc: 'SFGPUUL--------', keywords: 'شرطة أمن إنفاذ القانون', en: 'Law enforcement' },
  { key: 'security_police', label: 'شرطة أمن', category: 'security', sidc: 'SFGPUULS-------', keywords: 'شرطة أمن حماية منشآت', en: 'Security police' },
  { key: 'internal_security', label: 'أمن داخلي', category: 'security', sidc: 'SFGPUCS--------', keywords: 'أمن داخلي قوات أمن', en: 'Internal security' },
  // المنشآت
  { key: 'power', label: 'محطة كهرباء', category: 'facilities', sidc: 'SFGPIUE---H----', keywords: 'كهرباء طاقة محطة مولدات', en: 'Electric power' },
  { key: 'petroleum', label: 'منشأة نفط وغاز', category: 'facilities', sidc: 'SFGPIRP---H----', keywords: 'نفط غاز بترول مصفاة', en: 'Petroleum / gas' },
  { key: 'mine', label: 'منجم', category: 'facilities', sidc: 'SFGPIRM---H----', keywords: 'منجم مواد خام', en: 'Mine' },
  { key: 'nbc_facility', label: 'منشأة كيميائية', category: 'facilities', sidc: 'SFGPIRNC--H----', keywords: 'كيميائي منشأة مواد', en: 'Chemical facility' },
  { key: 'research', label: 'مركز أبحاث', category: 'facilities', sidc: 'SFGPIUR---H----', keywords: 'أبحاث بحوث مختبر', en: 'Research facility' },
  { key: 'manufacture', label: 'مصنع', category: 'facilities', sidc: 'SFGPIE----H----', keywords: 'مصنع تصنيع إنتاج', en: 'Equipment manufacture' },
  { key: 'processing', label: 'منشأة معالجة', category: 'facilities', sidc: 'SFGPIP----H----', keywords: 'معالجة تكرير', en: 'Processing facility' },
  { key: 'materiel', label: 'مستودع عتاد', category: 'facilities', sidc: 'SFGPIM----H----', keywords: 'عتاد مستودع مخازن', en: 'Military materiel facility' },
  { key: 'aircraft_production', label: 'مصنع طائرات', category: 'facilities', sidc: 'SFGPIMA---H----', keywords: 'طائرات تصنيع', en: 'Aircraft production' },
  { key: 'vehicle_production', label: 'مصنع آليات', category: 'facilities', sidc: 'SFGPIMV---H----', keywords: 'آليات مركبات تصنيع', en: 'Vehicle production' },
  { key: 'transport_facility', label: 'منشأة نقل', category: 'facilities', sidc: 'SFGPIT----H----', keywords: 'نقل منشأة طرق', en: 'Transport facility' },
  { key: 'utility', label: 'منشأة خدمات', category: 'facilities', sidc: 'SFGPIU----H----', keywords: 'خدمات مرافق', en: 'Utility facility' },
];

const SIDC_2525C = /^[A-Z][A-Z-][A-Z-][A-Z-][A-Z0-9-]{6}[A-Z0-9-]{5}$/;
const SIDC_APP6D = /^[0-9]{20}([0-9]{10})?$/;

/** Why a typed code cannot be a site symbol ('' when it can) — the same rule as the server (SiteService.symbolStandard). */
export function symbolProblem(code: string): string {
  const c = code.trim().toUpperCase();
  if (SIDC_2525C.test(c)) return c[0] === 'G' || c[0] === 'W' ? 'الرسوم التكتيكية وإجراءات السيطرة ورموز الطقس ليست رموز مواقع في هذا النظام.' : '';
  if (SIDC_APP6D.test(c)) return ['25', '45', '46'].includes(c.slice(4, 6)) ? 'الرسوم التكتيكية وإجراءات السيطرة ورموز الطقس ليست رموز مواقع في هذا النظام.' : '';
  return 'رمز غير صالح: يُقبل رمز MIL-STD-2525C من 15 حرفاً أو رمز APP-6D من 20 رقماً.';
}

/** milsymbol's standard for a code: the letter codes are MIL-STD-2525C, the number codes APP-6D. */
export const rendererStandard = (sidc: string) => (/^[0-9]/.test(sidc) ? 'APP6' : '2525');

/** The catalogue entry of a code, for its Arabic name; null for a code typed by hand. */
export const symbolEntry = (sidc: string | null | undefined) => SITE_SYMBOLS.find((s) => s.sidc === sidc) ?? null;
