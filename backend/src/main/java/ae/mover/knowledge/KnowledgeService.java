package ae.mover.knowledge;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * TMRKZ's knowledge bundle in TNQL's OKF format (owner, 11 Nov 2026; ADR-054): short Markdown documents with a front matter
 * (`okf_version`, `type`, `resource`, `title`, `lifecycle`, `verified`, `audience`, `keywords`, `screen`) and a manifest that
 * pins each document's sha256 and provenance. Loaded once from the classpath (`okf/`); a document whose bytes do not match
 * the manifest, that is not `current`, or whose review state is not `verified-current` is never served.
 *
 * <p>The search is deterministic and offline, as TNQL's: Arabic-aware normalisation and tokens, weighted title, keyword and
 * body matches, and each hit carries its `tmrkz://okf/...` resource as the citation. Documents are filtered by audience:
 * `all`, a permission the person holds anywhere, or `SUPPORT_SEAT`.
 */
@Service
public class KnowledgeService {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeService.class);
    static final Set<String> TYPES = Set.of("how-to", "concept", "reference", "troubleshooting");
    /** Question and joining words, in the normalised spelling the tokens use. */
    private static final Set<String> STOP = java.util.stream.Stream.of("في", "من", "على", "إلى", "الى", "عن", "ما", "ماذا", "كيف", "هل",
            "أن", "ان", "أو", "او", "ثم", "مع", "هذا", "هذه", "ذلك", "التي", "الذي", "أين", "اين", "متى", "لماذا", "أريد", "اريد", "ابغى",
            "ابي", "عندي", "لا", "لم", "لن", "قد", "كل", "يتم", "به", "بها", "له", "لها", "the", "a", "to", "of", "and", "how", "i")
            .map(KnowledgeService::normalise).collect(java.util.stream.Collectors.toUnmodifiableSet());

    public record Doc(String path, String resource, String type, String title, String screen, String verified, List<String> audience,
                      List<String> keywords, String body, String origin, Set<String> titleTokens, Set<String> keywordTokens,
                      List<String> bodyTokens) {
    }

    private final List<Doc> docs = new ArrayList<>();
    private final List<String> refused = new ArrayList<>();
    private String bundle = "";

    public KnowledgeService() {
        load("okf/");
    }

    KnowledgeService(String root) {
        load(root);
    }

    // ---- loading -------------------------------------------------------------------------------------------------

    private void load(String root) {
        try (InputStream in = new ClassPathResource(root + "manifest.json").getInputStream()) {
            JsonNode manifest = new ObjectMapper().readTree(in);
            bundle = manifest.path("bundle").asText("") + " " + manifest.path("okf_version").asText("");
            for (JsonNode d : manifest.path("documents")) {
                String path = d.path("path").asText();
                try {
                    byte[] bytes = new ClassPathResource(root + path).getContentAsByteArray();
                    if (!sha256(bytes).equals(d.path("sha256").asText())) {
                        refuse(path, "sha256 differs from the manifest");
                        continue;
                    }
                    if (!"verified-current".equals(d.path("provenance").path("review_state").asText())) {
                        refuse(path, "review state " + d.path("provenance").path("review_state").asText());
                        continue;
                    }
                    Doc doc = parse(path, new String(bytes, StandardCharsets.UTF_8), d.path("provenance").path("origin").asText(""));
                    if (doc == null) {
                        continue;
                    }
                    if (!doc.resource().equals(d.path("resource").asText())) {
                        refuse(path, "resource differs from the manifest");
                        continue;
                    }
                    docs.add(doc);
                } catch (IOException e) {
                    refuse(path, "missing");
                }
            }
        } catch (IOException e) {
            log.warn("knowledge bundle not found under {}", root);
        }
        log.info("knowledge bundle {}: {} documents served, {} refused", bundle.trim(), docs.size(), refused.size());
    }

    private void refuse(String path, String why) {
        refused.add(path + ": " + why);
        log.warn("knowledge document {} refused: {}", path, why);
    }

    /** The front matter (a controlled subset: `key: value` and `key: [a, b]`) and the Markdown body. */
    private Doc parse(String path, String text, String origin) {
        String t = text.replace("\r\n", "\n");
        if (!t.startsWith("---\n")) {
            refuse(path, "no front matter");
            return null;
        }
        int end = t.indexOf("\n---\n", 4);
        if (end < 0) {
            refuse(path, "front matter not closed");
            return null;
        }
        Map<String, String> fm = new LinkedHashMap<>();
        for (String line : t.substring(4, end).split("\n")) {
            int c = line.indexOf(':');
            if (c > 0) {
                fm.put(line.substring(0, c).trim(), unquote(line.substring(c + 1).trim()));
            }
        }
        String body = t.substring(end + 5).trim();
        if (!"current".equals(fm.get("lifecycle")) || !TYPES.contains(fm.get("type")) || fm.get("resource") == null || fm.get("title") == null) {
            refuse(path, "lifecycle, type, resource or title");
            return null;
        }
        List<String> keywords = list(fm.get("keywords"));
        List<String> audience = list(fm.get("audience"));
        return new Doc(path, fm.get("resource"), fm.get("type"), fm.get("title"), blank(fm.get("screen")), fm.get("verified"),
                audience.isEmpty() ? List.of("all") : audience, keywords, body, origin, Set.copyOf(tokens(fm.get("title"))),
                Set.copyOf(tokens(String.join(" ", keywords))), tokens(body));
    }

    private static String unquote(String v) {
        return v.length() >= 2 && (v.startsWith("\"") && v.endsWith("\"")) ? v.substring(1, v.length() - 1) : v;
    }

    private static String blank(String v) {
        return v == null || v.isBlank() ? null : v;
    }

    private static List<String> list(String v) {
        if (v == null || v.isBlank()) {
            return List.of();
        }
        String s = v.startsWith("[") && v.endsWith("]") ? v.substring(1, v.length() - 1) : v;
        return Arrays.stream(s.split(",")).map(String::trim).map(KnowledgeService::unquote).filter(x -> !x.isEmpty()).toList();
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- Arabic-aware text -----------------------------------------------------------------------------------------

    /** One spelling for the variants Arabic writers use: no diacritics or tatweel, one alef, ي for ى, ه for ة, Latin digits. */
    static String normalise(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder b = new StringBuilder(s.length());
        for (char ch : s.toLowerCase(Locale.ROOT).toCharArray()) {
            if ((ch >= 'ً' && ch <= 'ْ') || ch == 'ٰ' || ch == 'ـ') {
                continue;
            }
            switch (ch) {
                case 'أ', 'إ', 'آ', 'ٱ' -> b.append('ا');
                case 'ى' -> b.append('ي');
                case 'ة' -> b.append('ه');
                case 'ؤ' -> b.append('و');
                case 'ئ' -> b.append('ي');
                default -> {
                    if (ch >= '٠' && ch <= '٩') {
                        b.append((char) ('0' + ch - '٠'));
                    } else {
                        b.append(ch);
                    }
                }
            }
        }
        return b.toString();
    }

    /** Words without the article and its joined prepositions (ال، وال، بال، لل، فال، كال), stop words left out. */
    static List<String> tokens(String s) {
        List<String> out = new ArrayList<>();
        for (String w : normalise(s).split("[^\\p{L}\\p{N}]+")) {
            if (w.isEmpty()) {
                continue;
            }
            String x = w;
            for (String p : List.of("وال", "بال", "فال", "كال", "لل", "ال")) {
                if (x.startsWith(p) && x.length() - p.length() >= 2) {
                    x = x.substring(p.length());
                    break;
                }
            }
            if (x.length() >= 2 && !STOP.contains(w) && !STOP.contains(x)) {
                out.add(x);
            }
        }
        return out;
    }

    // ---- search --------------------------------------------------------------------------------------------------

    public record Hit(Doc doc, int score, String snippet) {
    }

    public List<Hit> search(String query, Predicate<Doc> visible, int limit) {
        List<String> q = tokens(query);
        if (q.isEmpty()) {
            return List.of();
        }
        String phrase = normalise(query).trim();
        List<Hit> hits = new ArrayList<>();
        for (Doc d : docs) {
            if (!visible.test(d)) {
                continue;
            }
            int score = 0;
            int matched = 0;
            for (String t : q) {
                int s = 0;
                if (d.titleTokens().contains(t)) {
                    s += 6;
                } else if (t.length() >= 3 && d.titleTokens().stream().anyMatch(x -> x.startsWith(t) || t.startsWith(x) && x.length() >= 3)) {
                    s += 3;
                }
                if (d.keywordTokens().contains(t)) {
                    s += 4;
                } else if (t.length() >= 3 && d.keywordTokens().stream().anyMatch(x -> x.startsWith(t))) {
                    s += 2;
                }
                long inBody = d.bodyTokens().stream().filter(x -> x.equals(t) || t.length() >= 3 && x.startsWith(t)).count();
                s += (int) Math.min(3, inBody);
                score += s;
                matched += s > 0 ? 1 : 0;
            }
            if (phrase.length() >= 4 && normalise(d.title()).contains(phrase)) {
                score += 8;
            }
            // most of the question must be about this document
            if (score > 0 && matched * 2 >= q.size()) {
                hits.add(new Hit(d, score, snippet(d.body(), q)));
            }
        }
        hits.sort(Comparator.comparingInt(Hit::score).reversed().thenComparing(h -> h.doc().title()));
        return hits.subList(0, Math.min(limit, hits.size()));
    }

    /** The first line of the body that holds one of the words, without Markdown marks. */
    private static String snippet(String body, List<String> q) {
        for (String line : body.split("\n")) {
            if (line.startsWith("#")) {
                continue; // a heading repeats the title the hit already shows
            }
            String plain = line.replaceAll("^[#>*\\-\\d.\\s]+", "").replace("**", "").replace("`", "").trim();
            if (plain.length() < 8) {
                continue;
            }
            List<String> lt = tokens(plain);
            if (q.stream().anyMatch(t -> lt.stream().anyMatch(x -> x.equals(t) || t.length() >= 3 && x.startsWith(t)))) {
                return plain.length() > 220 ? plain.substring(0, 217) + "…" : plain;
            }
        }
        String first = body.replaceAll("[#>*`]", "").trim();
        int nl = first.indexOf('\n');
        first = nl > 0 ? first.substring(0, nl) : first;
        return first.length() > 220 ? first.substring(0, 217) + "…" : first;
    }

    public List<Doc> all(Predicate<Doc> visible) {
        return docs.stream().filter(visible).sorted(Comparator.comparing(Doc::type).thenComparing(Doc::title)).toList();
    }

    public Doc byResource(String resource) {
        return docs.stream().filter(d -> d.resource().equals(resource)).findFirst().orElse(null);
    }

    public String bundle() {
        return bundle.trim();
    }

    public List<String> refused() {
        return List.copyOf(refused);
    }

    public int size() {
        return docs.size();
    }
}
