package io.github.clockwerks77.eveops

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class SessionTest {
    private fun jwt(claims: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString("""{"alg":"RS256"}""".toByteArray()) + "." + enc.encodeToString(claims.toByteArray()) + ".signature"
    }

    @Test
    fun challengeMatchesTheExampleInTheStandard() {
        // RFC 7636, appendix B
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun randomStringsAreUrlSafeAndDiffer() {
        val a = Pkce.random(32)
        assertTrue(a.matches(Regex("[A-Za-z0-9_-]{43}")))
        assertNotEquals(a, Pkce.random(32))
    }

    @Test
    fun readsWhoSignedInFromEvesAnswer() {
        val answer = JSONObject()
            .put("access_token", jwt("""{"sub":"CHARACTER:EVE:92279686","name":"Todashi Kitsune","scp":["esi-wallet.read_character_wallet.v1","esi-assets.read_assets.v1"]}"""))
            .put("refresh_token", "refresh-one").put("expires_in", 1199)
        val s = Session.fromAnswer(answer, 1_000_000)
        assertEquals(92279686L, s.id)
        assertEquals("Todashi Kitsune", s.name)
        assertEquals(2, s.scopes.size)
        assertEquals("refresh-one", s.refresh)
        assertEquals(1_000_000 + 1139 * 1000L, s.exp)      // a minute's margin before EVE's own expiry
        assertEquals(s, Session.fromJson(s.toJson()))
    }

    @Test
    fun keepsTheOldRefreshTokenWhenEveSendsNone() {
        val answer = JSONObject().put("access_token", jwt("""{"sub":"CHARACTER:EVE:92174464","name":"Khiana Kyn","scp":"esi-location.read_location.v1"}"""))
        val s = Session.fromAnswer(answer, 0, "refresh-old")
        assertEquals("refresh-old", s.refresh)
        assertEquals(listOf("esi-location.read_location.v1"), s.scopes)
    }

    @Test
    fun badStoredSessionReadsAsSignedOut() {
        assertNull(Session.fromJson("not json"))
        assertNull(Session.fromJson("""{"access":"x"}"""))
    }
}
