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
<body class="tm-body ${bodyClass}">
<div class="tm-backdrop" aria-hidden="true"></div>
<main class="tm-shell">
    <section class="tm-card" aria-labelledby="tm-title">
        <header class="tm-brand">
            <span class="tm-mark" aria-hidden="true"></span>
            <span class="tm-brand-text">
                <strong>TMRKZ</strong>
                <small>المواقع · المرافق · الإجراءات الإدارية</small>
            </span>
        </header>
        <h1 id="tm-title"><#nested "header"></h1>
        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="tm-alert tm-alert-${message.type}" role="alert" aria-live="polite">${kcSanitize(message.summary)?no_esc}</div>
        </#if>
        <#nested "form">
        <footer class="tm-foot"><#nested "info"></footer>
    </section>
</main>
</body>
</html>
</#macro>
