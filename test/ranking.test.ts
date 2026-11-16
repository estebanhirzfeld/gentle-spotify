import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlayArgs, parseTrackRef, pickTrack, type Track } from "../src/spotify.ts";

const t = (name: string, artists: string[], uri = `spotify:track:${name.replace(/\W/g, "")}`): Track => ({
	uri,
	name,
	artists,
	album: "Album",
	year: "2000",
});

// Spotify's real top results for "My name is Eminem": popularity puts Without Me first.
const eminem = [
	t("Without Me", ["Eminem"], "spotify:track:WITHOUT_ME"),
	t("Mockingbird", ["Eminem"], "spotify:track:MOCKINGBIRD"),
	t("My Name Is", ["Eminem"], "spotify:track:MY_NAME_IS"),
	t("My Name Is - Remix", ["Eminem"], "spotify:track:MY_NAME_IS_REMIX"),
];

test("S2: 'My name is Eminem' resolves to My Name Is, not Without Me", () => {
	assert.equal(pickTrack("My name is Eminem", eminem)?.uri, "spotify:track:MY_NAME_IS");
});

test("S2: word order does not matter", () => {
	assert.equal(pickTrack("Eminem my name is", eminem)?.uri, "spotify:track:MY_NAME_IS");
});

test("S4: the exact title beats a longer variant of it", () => {
	assert.equal(pickTrack("my name is", eminem)?.uri, "spotify:track:MY_NAME_IS");
});

test("S4: ties keep Spotify's order", () => {
	assert.equal(pickTrack("eminem", eminem)?.uri, "spotify:track:WITHOUT_ME");
});

test("S4: same input gives the same pick every time", () => {
	const picks = new Set(Array.from({ length: 20 }, () => pickTrack("My name is Eminem", eminem)?.uri));
	assert.equal(picks.size, 1);
});

test("accents and punctuation do not break matching", () => {
	const tracks = [t("Otra", ["X"]), t("Canción Animal", ["Soda Stereo"], "spotify:track:CANCION")];
	assert.equal(pickTrack("cancion animal soda", tracks)?.uri, "spotify:track:CANCION");
});

test("artist filter is case-insensitive and excludes other artists", () => {
	const tracks = [t("My Name Is", ["Someone Else"], "spotify:track:OTHER"), ...eminem];
	assert.equal(pickTrack("my name is", tracks, "EMINEM")?.uri, "spotify:track:MY_NAME_IS");
	assert.equal(pickTrack("my name is", tracks, "someone")?.uri, "spotify:track:OTHER");
});

test("artist filter with no match returns null", () => {
	assert.equal(pickTrack("my name is", eminem, "Nirvana"), null);
});

test("an empty result list returns null", () => {
	assert.equal(pickTrack("anything", []), null);
});

test("parseTrackRef accepts URIs and open.spotify.com links", () => {
	assert.equal(parseTrackRef("spotify:track:75IN3CtuZwTHTnZvYM4qnJ"), "spotify:track:75IN3CtuZwTHTnZvYM4qnJ");
	assert.equal(
		parseTrackRef("https://open.spotify.com/track/75IN3CtuZwTHTnZvYM4qnJ?si=abc"),
		"spotify:track:75IN3CtuZwTHTnZvYM4qnJ",
	);
	assert.equal(parseTrackRef("https://open.spotify.com/intl-es/track/75IN3CtuZwTHTnZvYM4qnJ"), "spotify:track:75IN3CtuZwTHTnZvYM4qnJ");
	assert.equal(parseTrackRef("my name is"), null);
	assert.equal(parseTrackRef('spotify:track:abc" & do shell script "x'), null);
});

test("parsePlayArgs splits --artist from the query", () => {
	assert.deepEqual(parsePlayArgs(""), { query: "", artist: undefined });
	assert.deepEqual(parsePlayArgs("  my name is  "), { query: "my name is", artist: undefined });
	assert.deepEqual(parsePlayArgs("--artist Eminem my name is"), { query: "my name is", artist: "Eminem" });
	assert.deepEqual(parsePlayArgs('--artist "Soda Stereo" persiana americana'), {
		query: "persiana americana",
		artist: "Soda Stereo",
	});
});
