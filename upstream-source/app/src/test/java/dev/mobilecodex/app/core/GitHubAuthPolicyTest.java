package dev.mobilecodex.app.core;

import org.junit.Test;
import java.io.IOException;
import java.util.List;
import static org.junit.Assert.*;

public class GitHubAuthPolicyTest {
    @Test public void clientIdMustBeExplicitAndCannotContainCredentialOrFormSyntax() throws Exception {
        assertEquals("", GitHubAuthPolicy.clientId(null));
        assertEquals("Iv1.own-fixture", GitHubAuthPolicy.clientId(" Iv1.own-fixture "));
        for (String invalid : new String[]{"short", "id with spaces", "fixture&scope=repo", "https://github.com"})
            assertThrows(IOException.class, () -> GitHubAuthPolicy.clientId(invalid));
    }

    @Test public void authorizationCanUseOnlyTheThreeFixedEndpoints() {
        assertTrue(GitHubAuthPolicy.endpointAllowed("POST", GitHubAuthPolicy.DEVICE_URL));
        assertTrue(GitHubAuthPolicy.endpointAllowed("POST", GitHubAuthPolicy.TOKEN_URL));
        assertTrue(GitHubAuthPolicy.endpointAllowed("GET", GitHubAuthPolicy.USER_URL));
        assertFalse(GitHubAuthPolicy.endpointAllowed("GET", GitHubAuthPolicy.TOKEN_URL));
        assertFalse(GitHubAuthPolicy.endpointAllowed("POST", "https://github.com/login/oauth/access_token?redirect=1"));
        assertFalse(GitHubAuthPolicy.endpointAllowed("GET", "https://api.github.com/user/emails"));
        assertFalse(GitHubAuthPolicy.endpointAllowed("GET", "https://api.github.com.evil.test/user"));
    }

    @Test public void devicePageCannotRedirectTheUserToAnotherHostOrCarryHiddenParameters() throws Exception {
        assertEquals(GitHubAuthPolicy.VERIFICATION_URI, GitHubAuthPolicy.verificationUri("https://github.com/login/device"));
        for (String invalid : new String[]{"http://github.com/login/device", "https://github.com.evil.test/login/device", "https://github.com/login/device?code=x", "https://user@github.com/login/device"})
            assertThrows(IOException.class, () -> GitHubAuthPolicy.verificationUri(invalid));
    }

    @Test public void onlyRequestedPublicRepositoryAndWorkflowScopesAreAccepted() throws Exception {
        assertEquals(List.of("workflow", "public_repo"), GitHubAuthPolicy.scopes("workflow, public_repo,workflow"));
        GitHubAuthPolicy.requireScopes(GitHubAuthPolicy.scopes("public_repo workflow"));
        assertTrue(assertThrows(IOException.class, () -> GitHubAuthPolicy.requireScopes(List.of("public_repo"))).getMessage().contains("范围不足"));
        for (List<String> broad : List.of(List.of("repo", "workflow"), List.of("public_repo", "workflow", "read:user")))
            assertTrue(assertThrows(IOException.class, () -> GitHubAuthPolicy.requireScopes(broad)).getMessage().contains("权限过宽"));
    }

    @Test public void credentialHelperRejectsOtherHostsPortsProtocolsAndPathInjection() {
        assertTrue(GitHubAuthPolicy.credentialAllowed("https", "github.com", "owner/project.git"));
        assertTrue(GitHubAuthPolicy.credentialAllowed("https", "GITHUB.COM", ""));
        assertTrue(GitHubAuthPolicy.credentialAllowed("https", "github.com", null));
        for (String host : new String[]{"github.com.evil.test", "user@github.com", "github.com:443", "github.com\npassword=x"})
            assertFalse(GitHubAuthPolicy.credentialAllowed("https", host, "owner/project.git"));
        assertFalse(GitHubAuthPolicy.credentialAllowed("http", "github.com", "owner/project.git"));
        assertFalse(GitHubAuthPolicy.credentialAllowed("ssh", "github.com", "owner/project.git"));
        for (String path : new String[]{"owner/repo.git\npassword=x", "owner/repo?key=x", "../repo", "https://evil.test/repo", "owner\\repo"})
            assertFalse(GitHubAuthPolicy.credentialAllowed("https", "github.com", path));
    }

    @Test public void intervalsAndExpiryFieldsAreBoundedAndNeverPollFasterThanFiveSeconds() throws Exception {
        assertEquals(5000, GitHubAuthPolicy.pollIntervalMillis(null));
        assertEquals(5000, GitHubAuthPolicy.pollIntervalMillis(1));
        assertEquals(9000, GitHubAuthPolicy.pollIntervalMillis(9));
        assertEquals(0, GitHubAuthPolicy.tokenLifetimeSeconds(null));
        assertEquals(28800, GitHubAuthPolicy.tokenLifetimeSeconds(28800));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.deviceLifetimeSeconds(null));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.deviceLifetimeSeconds(0));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.deviceLifetimeSeconds(1.5));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.pollIntervalMillis(Double.NaN));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.tokenLifetimeSeconds(-1));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.deadline(Long.MAX_VALUE, 10));
    }

    @Test public void tokensAndUserCodesCannotInjectHeadersOrUiMarkup() throws Exception {
        assertEquals("fixture_token", GitHubAuthPolicy.accessToken("fixture_token"));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.accessToken("fixture\r\nAuthorization: x"));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.accessToken("中文token"));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.deviceCode(""));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.userCode("<script>"));
        assertThrows(IOException.class, () -> GitHubAuthPolicy.login("wrong account"));
    }
}
