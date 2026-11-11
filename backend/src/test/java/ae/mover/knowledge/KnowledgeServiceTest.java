package ae.mover.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** TMRKZ's OKF knowledge bundle (ADR-054): loading rules, Arabic-aware search and the audience filter; no database. */
class KnowledgeServiceTest {

    @Test
    @DisplayName("KB-1: Arabic spelling variants meet: hamza, ta marbuta, alef maqsura, diacritics, tatweel, the article")
    void normalise() {
        assertThat(KnowledgeService.normalise("إضافةُ مستخدمٍ")).isEqualTo(KnowledgeService.normalise("اضافه مستخدم"));
        assertThat(KnowledgeService.normalise("مستـــوى")).isEqualTo("مستوي");
        assertThat(KnowledgeService.normalise("٢٠٢٦")).isEqualTo("2026");
        assertThat(KnowledgeService.tokens("كيف أضيف المستخدم إلى الوحدة؟")).containsExactly("اضيف", "مستخدم", "وحده");
    }

    @Test
    @DisplayName("KB-2: only documents matching the manifest, current and verified-current are served")
    void loading() {
        KnowledgeService k = new KnowledgeService("okf-test/");
        assertThat(k.size()).isEqualTo(1);
        assertThat(k.byResource("tmrkz://okf/how-to/good")).isNotNull();
        assertThat(String.join("\n", k.refused())).contains("tampered.md: sha256 differs").contains("draft.md: lifecycle")
                .contains("unverified.md: review state").contains("missing.md: missing");
    }

    @Test
    @DisplayName("KB-3: the real bundle: a question in everyday spelling finds its guide with a citation; the audience is respected")
    void searchRealBundle() {
        KnowledgeService k = new KnowledgeService();
        assertThat(k.refused()).as("every shipped document verifies").isEmpty();
        assertThat(k.size()).isGreaterThanOrEqualTo(11);
        List<KnowledgeService.Hit> hits = k.search("كيف اضيف مستخدم للوحده", d -> true, 6);
        assertThat(hits).isNotEmpty();
        assertThat(hits.get(0).doc().resource()).isEqualTo("tmrkz://okf/how-to/add-user");
        assertThat(hits.get(0).snippet()).isNotBlank();
        // a person without MANAGE_ACCESS does not get the access managers' guide
        List<KnowledgeService.Hit> plain = k.search("كيف اضيف مستخدم للوحده", d -> d.audience().contains("all"), 6);
        assertThat(plain).noneMatch(h -> h.doc().resource().equals("tmrkz://okf/how-to/add-user"));
        assertThat(k.search("لا تصلني الاشعارات", d -> true, 3).get(0).doc().resource()).isEqualTo("tmrkz://okf/how-to/desktop-notifications");
        assertThat(k.search("لماذا يرفض دخولي", d -> true, 3).get(0).doc().resource()).isEqualTo("tmrkz://okf/troubleshooting/sign-in-refused");
        assertThat(k.search("ابلغ عن مشكله", d -> true, 3).get(0).doc().resource()).isEqualTo("tmrkz://okf/how-to/support-report");
        assertThat(k.search("رسم حدود موقع جديد بالاحداثيات", d -> true, 3).get(0).doc().resource()).isEqualTo("tmrkz://okf/how-to/new-site");
        assertThat(k.search("كيف", d -> true, 3)).as("a question of stop words only finds nothing").isEmpty();
        assertThat(k.search("طائرة فضائية", d -> true, 3)).as("nothing unrelated").isEmpty();
    }
}
