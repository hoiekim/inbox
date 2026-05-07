/**
 * DNSBL Checker Tests
 * 
 * Tests for DNS blocklist checking functionality.
 */

import { describe, it, expect } from "bun:test";
import { checkDnsbls, DEFAULT_DNSBLS, isRealListing } from "./dnsbl";

describe("DNSBL Checker", () => {
  describe("checkDnsbls", () => {
    it("should skip private IP addresses", async () => {
      const privateIps = [
        "127.0.0.1",     // localhost
        "10.0.0.1",      // private 10.x.x.x
        "172.16.0.1",    // private 172.16-31.x.x
        "172.31.255.255",
        "192.168.1.1",   // private 192.168.x.x
        "169.254.1.1",   // link-local
      ];

      for (const ip of privateIps) {
        const result = await checkDnsbls(ip);
        expect(result.score).toBe(0);
        expect(result.listedIn).toEqual([]);
        expect(result.reasons).toEqual([]);
      }
    });

    it("should handle invalid IP addresses gracefully", async () => {
      const invalidIps = [
        "not-an-ip",
        "256.1.1.1",
        "1.2.3",
        "1.2.3.4.5",
        "",
      ];

      for (const ip of invalidIps) {
        const result = await checkDnsbls(ip);
        // Should not crash, just return empty results
        expect(result.score).toBe(0);
        expect(result.listedIn).toEqual([]);
      }
    });

    it("should use default DNSBLs when none provided", async () => {
      // Test that it doesn't crash when checking a public IP
      // We use a known test IP that shouldn't be listed
      const result = await checkDnsbls("1.1.1.1");
      
      // Cloudflare DNS (1.1.1.1) should not be on any blocklist
      expect(result.score).toBe(0);
    });

    it("should aggregate scores from multiple DNSBLs", async () => {
      // This is a structural test - we verify the aggregation logic works
      // by checking the return type structure
      const result = await checkDnsbls("8.8.8.8", DEFAULT_DNSBLS);
      
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("listedIn");
      expect(result).toHaveProperty("reasons");
      expect(typeof result.score).toBe("number");
      expect(Array.isArray(result.listedIn)).toBe(true);
      expect(Array.isArray(result.reasons)).toBe(true);
    });

    it("should handle DNS query failures gracefully", async () => {
      // Use a custom DNSBL list with an invalid hostname
      const fakeDnsbls = [
        { hostname: "invalid.nonexistent.dnsbl.local", name: "Fake DNSBL", score: 100 },
      ];

      const result = await checkDnsbls("8.8.8.8", fakeDnsbls);
      
      // Should not crash, just return 0 score
      expect(result.score).toBe(0);
      expect(result.listedIn).toEqual([]);
    });
  });

  describe("isRealListing", () => {
    it("treats 127.0.0.X addresses as real listings", () => {
      expect(isRealListing(["127.0.0.2"])).toBe(true);  // Spamhaus SBL
      expect(isRealListing(["127.0.0.4"])).toBe(true);  // Spamhaus CSS
      expect(isRealListing(["127.0.0.10"])).toBe(true); // Spamhaus PBL
      expect(isRealListing(["127.0.0.2", "127.0.0.10"])).toBe(true);
    });

    it("ignores 127.255.255.X open-resolver warnings", () => {
      // Spamhaus returns these when the query arrives via a public resolver
      // (Google, Cloudflare, etc.). They are *warnings*, not listings —
      // treating them as listings flags every incoming mail as spam.
      expect(isRealListing(["127.255.255.252"])).toBe(false);
      expect(isRealListing(["127.255.255.253"])).toBe(false);
      expect(isRealListing(["127.255.255.254"])).toBe(false);
      expect(isRealListing(["127.255.255.255"])).toBe(false);
    });

    it("ignores mixed responses that contain only warnings", () => {
      expect(isRealListing(["127.255.255.252", "127.255.255.254"])).toBe(false);
    });

    it("counts as a listing when at least one 127.0.X.X record is present", () => {
      // Defensive: if a future Spamhaus response somehow returns both a real
      // listing code AND a warning code, the real listing should win.
      expect(isRealListing(["127.0.0.2", "127.255.255.254"])).toBe(true);
    });

    it("returns false on empty results", () => {
      expect(isRealListing([])).toBe(false);
    });

    it("ignores non-127.0.X.X responses (e.g. ISP DNS hijack ad pages)", () => {
      // Some ISPs / captive portals return a content IP for NXDOMAIN.
      // Those must not be treated as DNSBL listings.
      expect(isRealListing(["192.0.2.1"])).toBe(false);
      expect(isRealListing(["10.0.0.1"])).toBe(false);
    });
  });

  describe("DEFAULT_DNSBLS", () => {
    it("should have expected structure", () => {
      expect(DEFAULT_DNSBLS.length).toBeGreaterThan(0);
      
      for (const dnsbl of DEFAULT_DNSBLS) {
        expect(dnsbl).toHaveProperty("hostname");
        expect(dnsbl).toHaveProperty("name");
        expect(dnsbl).toHaveProperty("score");
        expect(typeof dnsbl.hostname).toBe("string");
        expect(typeof dnsbl.name).toBe("string");
        expect(typeof dnsbl.score).toBe("number");
        expect(dnsbl.score).toBeGreaterThan(0);
      }
    });

    it("should include major blocklists", () => {
      const hostnames = DEFAULT_DNSBLS.map(d => d.hostname);
      
      expect(hostnames).toContain("zen.spamhaus.org");
      expect(hostnames).toContain("bl.spamcop.net");
    });
  });
});
