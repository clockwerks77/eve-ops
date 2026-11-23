package io.github.clockwerks77.eveops

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which notifications a summary from the dashboard page leads to. */
class AlertsTest {
    private fun summary(notify: String, alerts: String) = JSONObject("""{"v":1,"notify":$notify,"alerts":$alerts}""")

    private val three = """[
        {"id":"c11","kind":"change","text":"Dodixie: 10MN Afterburner II"},
        {"id":"c12","kind":"change","text":"Hek: Medium Shield Extender II"},
        {"id":"x40150003:1794700000000","kind":"extractors","text":"Alakgur III"},
        {"id":"f40150005","kind":"launchpad","text":"Alakgur V at 91%"}
    ]"""

    @Test
    fun onlyTheKindsAskedFor() {
        assertTrue(Alerts.wanted(summary("""{"change":false,"extractors":false,"launchpad":false}""", three)).isEmpty())
        val some = Alerts.wanted(summary("""{"change":true,"extractors":false,"launchpad":true}""", three))
        assertEquals(listOf("c11", "c12", "f40150005"), some.map { it.id })
        // a summary from an older page has neither field
        assertTrue(Alerts.wanted(JSONObject("""{"v":1}""")).isEmpty())
        // entries the app does not understand are passed over
        assertTrue(Alerts.wanted(summary("""{"change":true,"other":true}""", """[{"id":"","kind":"change","text":"x"},{"id":"q1","kind":"other","text":"y"},7]""")).isEmpty())
    }

    @Test
    fun eachThingIsToldOnce() {
        val all = Alerts.wanted(summary("""{"change":true,"extractors":true,"launchpad":true}""", three))
        val first = Alerts.notes(all, emptySet())
        assertEquals(listOf("change", "extractors", "launchpad"), first.map { it.kind })
        assertEquals("2 orders to change", first[0].title)
        assertEquals(listOf("Dodixie: 10MN Afterburner II", "Hek: Medium Shield Extender II"), first[0].lines)
        assertEquals("Extractors stopped on 1 colony", first[1].title)
        assertEquals("A launchpad is nearly full", first[2].title)
        assertEquals(listOf("Alakgur V at 91%"), first[2].lines)
        // the next check finds the same things: nothing to say
        assertTrue(Alerts.notes(all, all.map { it.id }.toSet()).isEmpty())
        // one more order loses the lead: only that one is news
        val later = all + Alerts.Alert("c13", "change", "Rens: Damage Control II")
        val second = Alerts.notes(later, all.map { it.id }.toSet())
        assertEquals(1, second.size)
        assertEquals("1 order to change", second[0].title)
        assertEquals(listOf("Rens: Damage Control II"), second[0].lines)
        // extractors restarted and stopped again carry a new id (the new stop time), so they are told again
        val again = listOf(Alerts.Alert("x40150003:1794900000000", "extractors", "Alakgur III"))
        assertEquals("Extractors stopped on 1 colony", Alerts.notes(again, all.map { it.id }.toSet())[0].title)
    }

    @Test
    fun aLongListIsCutShort() {
        val many = (1..9).map { Alerts.Alert("c$it", "change", "Jita: Item $it") }
        val note = Alerts.notes(many, emptySet())[0]
        assertEquals("9 orders to change", note.title)
        assertEquals(Alerts.MAX_LINES + 1, note.lines.size)
        assertEquals("and 3 more", note.lines.last())
        val two = (1..2).map { Alerts.Alert("f$it", "launchpad", "Planet $it at 90%") }
        assertEquals("2 launchpads are nearly full", Alerts.notes(two, emptySet())[0].title)
        val stopped = (1..3).map { Alerts.Alert("x$it", "extractors", "Planet $it") }
        assertEquals("Extractors stopped on 3 colonies", Alerts.notes(stopped, emptySet())[0].title)
    }

    @Test
    fun aMistypedPriceOrASaleUnderCost() {
        val alerts = """[
            {"id":"k7464:897200","kind":"check","text":"Hek: Heavy Neutron Blaster II at 897,200. 56% under the next seller. Check for a typo."},
            {"id":"u60005686:2961:2026-11-16:18","kind":"check","text":"Hek: sold 24 Heavy Neutron Blaster II under cost, down to 897,200 (-10.6M)"}
        ]"""
        // an older page's notify settings have no "check": nothing is told
        assertTrue(Alerts.wanted(summary("""{"change":true}""", alerts)).isEmpty())
        val all = Alerts.wanted(summary("""{"check":true}""", alerts))
        val note = Alerts.notes(all, emptySet())
        assertEquals(listOf("check"), note.map { it.kind })
        assertEquals("2 prices to check", note[0].title)
        assertEquals("1 price to check", Alerts.notes(all.take(1), emptySet())[0].title)
    }
}
