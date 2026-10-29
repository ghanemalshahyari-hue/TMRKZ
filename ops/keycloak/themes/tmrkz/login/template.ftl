<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="color-scheme" content="light">
    <title>TMRKZ — تسجيل الدخول</title>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet"/>
        </#list>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" defer></script>
        </#list>
    </#if>
</head>
<body class="tm ${bodyClass}">
<section class="tm-shell">
    <div class="tm-backdrop" aria-hidden="true"></div>
    <main class="tm-main">
        <div class="tm-card">
            <h1 class="tm-logo" id="tm-title">
                <span class="tm-mark" aria-hidden="true">
                    <svg viewBox="0 0 48 48" width="48" height="48"><path d="M24 4 41 14v20L24 44 7 34V14Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M24 13c-4.4 0-8 3.4-8 7.8C16 27 24 35 24 35s8-8 8-14.2C32 16.4 28.4 13 24 13Zm0 11a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z" fill="currentColor"/></svg>
                </span>
                <span class="tm-word">TMRKZ</span>
            </h1>
            <p class="tm-sub"><#nested "header"></p>
            <span class="tm-rule" aria-hidden="true"></span>
            <div class="tm-messages" role="status" aria-live="polite">
                <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                    <div class="tm-alert tm-alert-${message.type}">
                        <span class="tm-alert-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".16"/><path d="M12 7v6m0 3.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span>
                        <span>${kcSanitize(message.summary)?no_esc}</span>
                    </div>
                </#if>
            </div>
            <#nested "form">
            <p class="tm-foot"><#nested "info"></p>
        </div>
    </main>
    <aside class="tm-board" aria-label="إرشادات الدخول">
        <header class="tm-board-head">
            <strong>إرشادات الدخول</strong>
            <small>نظام المواقع والمرافق والإجراءات الإدارية</small>
        </header>
        <article class="tm-note">
            <span class="tm-note-meta">الحساب</span>
            <b>استخدم حسابك في الدليل المؤسسي</b>
            <p>اسم المستخدم وكلمة المرور نفسها المستخدمة في أجهزة العمل. يتحقق منها الدليل المؤسسي، ولا يحفظها النظام.</p>
        </article>
        <article class="tm-note">
            <span class="tm-note-meta">الصلاحيات</span>
            <b>الصلاحيات من جهتك</b>
            <p>تُمنح الصلاحيات وفق انتمائك الوظيفي والمسؤوليات المعتمدة، ولا تُمنح بمجرد امتلاك حساب.</p>
        </article>
        <article class="tm-note">
            <span class="tm-note-meta">الحماية</span>
            <b>حماية الحساب</b>
            <p>يُوقف الدخول مؤقتاً بعد محاولات خاطئة متكررة. لا تشارك كلمة المرور، وسجّل الخروج عند الانتهاء.</p>
        </article>
        <footer class="tm-board-foot">التشغيل داخل الشبكة الداخلية فقط</footer>
    </aside>
</section>
</body>
</html>
</#macro>
