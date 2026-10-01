package com.ebremer.lws.acp;

import com.ebremer.lws.config.LwsSettings;
import com.ebremer.lws.config.LwsStorageConfig;
import com.ebremer.lws.store.LwsStore;
import com.ebremer.lws.vocab.ACP;
import java.util.List;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.vocabulary.RDF;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Seeds the storage root's access control resource.
 *
 * <p>Without this a new storage is a deadlock: every operation is authorized against
 * an ACR, and creating the first ACR is itself an operation. So the first policy
 * cannot come from a request — it has to come from configuration, before the storage
 * accepts traffic.
 *
 * <p>Two policies are attached to the root, both as {@code acp:memberAccessControl}
 * so they inherit to every descendant:
 * <ul>
 *   <li><strong>owner</strong> — full control, to the WebID in {@code :LWSOwner}.</li>
 *   <li><strong>creator</strong> — whoever creates a resource may read, write and
 *       control <em>that</em> resource. Matched through {@code acp:CreatorAgent}, so
 *       it is evaluated per-target rather than naming anyone up front.</li>
 * </ul>
 *
 * <p>Nothing is granted to anonymous requests. Public access is a policy an owner
 * adds, never a default they have to remember to remove. The one exception is the
 * DEV/TEST ONLY {@code :LWSOpenMode} switch ({@code LwsSettings#openMode()}): it
 * adds a third policy granting the public agent ({@code acp:PublicAgent})
 * Read/Write/Append/Control on the root and every descendant, so an anonymous
 * client can provision and write without any credential — the same posture as
 * sparq's {@code SOLID_SERVER_OPEN_MODE} dev seed, for harnesses that send no
 * bearer token.
 */
public final class AcpBootstrap {

    private static final Logger LOG = LoggerFactory.getLogger(AcpBootstrap.class);

    private AcpBootstrap() {
    }

    /**
     * Thrown when a storage cannot be given a safe root policy. Aborts startup rather than mounting
     * a storage whose access control does not mean what it appears to.
     */
    public static final class UnownedStorageException extends IllegalStateException {
        private static final long serialVersionUID = 1L;

        UnownedStorageException(String message) {
            super(message);
        }
    }

    private static String requireOwner(String root) {
        String ownerWebId = LwsSettings.get().owner();
        if (ownerWebId != null && !ownerWebId.isBlank()) {
            return ownerWebId;
        }
        // This used to grant acp:AuthenticatedAgent Read+Write+Append+Control instead, reasoning
        // that a root ACR naming nobody "would lock everyone out, including whoever is trying to
        // configure the storage". That framing was wrong, and it is worth stating why so the
        // permissive default is not reinstated: :LWSOwner lives in settings.ttl, a FILE, not behind
        // the API this policy guards. An operator can always name an owner without first having
        // access, so there was never a bootstrapping deadlock to avoid -- and the price of avoiding
        // it was that the owner policy (Control included) hung off acp:memberAccessControl and so
        // inherited to every resource the storage would ever hold. Combined with a WebID login that
        // accepts any self-nominated provider, that is Control for anyone who can host a WebID
        // document, and no per-resource ACR can narrow it: inheritance in AcpEngine is a union, and
        // a stranger holding inherited Control can simply PUT the restriction away.
        throw new UnownedStorageException(
                "LWS storage " + root + " has no owner: set :LWSOwner <your-webid> in settings.ttl."
                + " Refusing to start, because the alternative is a storage whose root policy grants"
                + " full control -- Read, Write, Append AND Control, inherited by every resource in"
                + " it -- to any authenticated agent, and this server accepts any WebID that names"
                + " its own OpenID Provider unless :AllowedIssuer says otherwise.");
    }

    /** Idempotent: TDB2's single writer serializes the check and the seed. */
    public static void seed(LwsStore store, LwsStorageConfig cfg) {
        store.write(() -> {
            Model acp = store.acp();
            String root = cfg.storageRootUri();
            Resource acr = ResourceFactory.createResource(root + LwsStorageConfig.ACR_SUFFIX);
            String base = acr.getURI();
            Resource ownerMatcher = ResourceFactory.createResource(base + "#m-owner");

            if (acp.contains(acr, RDF.type, ACP.AccessControlResource)) {
                repairIfUnowned(acp, root, ownerMatcher);
                return;
            }

            String ownerWebId = requireOwner(root);
            Resource target = ResourceFactory.createResource(root);

            acp.add(acr, RDF.type, ACP.AccessControlResource);
            acp.add(acr, ACP.resource, target);

            acp.add(ownerMatcher, ACP.agent, ResourceFactory.createResource(ownerWebId));
            LOG.info("LWS storage {} owner: {}", root, ownerWebId);
            acp.add(ownerMatcher, RDF.type, ACP.Matcher);

            Resource ownerPolicy = policy(acp, base + "#pol-owner", ownerMatcher,
                    List.of(AccessMode.READ, AccessMode.WRITE, AccessMode.APPEND, AccessMode.CONTROL));
            Resource ownerAc = accessControl(acp, base + "#ac-owner", ownerPolicy);

            Resource creatorMatcher = ResourceFactory.createResource(base + "#m-creator");
            acp.add(creatorMatcher, RDF.type, ACP.Matcher);
            acp.add(creatorMatcher, ACP.agent, ACP.CreatorAgent);
            Resource creatorPolicy = policy(acp, base + "#pol-creator", creatorMatcher,
                    List.of(AccessMode.READ, AccessMode.WRITE, AccessMode.CONTROL));
            Resource creatorAc = accessControl(acp, base + "#ac-creator", creatorPolicy);

            // accessControl governs the root itself; memberAccessControl is what
            // reaches its descendants. Both are needed — the owner must be able to
            // POST to the root, and to touch what the root contains.
            acp.add(acr, ACP.accessControl, ownerAc);
            acp.add(acr, ACP.memberAccessControl, ownerAc);
            acp.add(acr, ACP.memberAccessControl, creatorAc);

            // DEV/TEST ONLY (:LWSOpenMode): open the storage to the public. The
            // ROOT ACR's accessControl governs the root itself and an
            // acp:memberAccessControl entry is what reaches descendants, so the
            // public policy must sit in both — the ACP analogue of sparq's
            // acl:accessTo + acl:default root ACL. The owner and creator policies
            // above are untouched: open mode is additive, an authenticated owner
            // keeps full control, and pulling it later is a PUT to the root ACR
            // (which the owner can still make).
            if (LwsSettings.get().openMode()) {
                Resource publicMatcher = ResourceFactory.createResource(base + "#m-public");
                acp.add(publicMatcher, RDF.type, ACP.Matcher);
                acp.add(publicMatcher, ACP.agent, ACP.PublicAgent);
                Resource publicPolicy = policy(acp, base + "#pol-public", publicMatcher,
                        List.of(AccessMode.READ, AccessMode.WRITE, AccessMode.APPEND,
                                AccessMode.CONTROL));
                Resource publicAc = accessControl(acp, base + "#ac-public", publicPolicy);
                acp.add(acr, ACP.accessControl, publicAc);
                acp.add(acr, ACP.memberAccessControl, publicAc);
                LOG.warn("LWS storage {} OPENED TO THE PUBLIC (DEV ONLY: :LWSOpenMode true) — "
                        + "anonymous clients hold Read/Write/Append/Control on the root and "
                        + "every descendant", root);
            }

            LOG.info("seeded ACP root policy for {}", root);
        });
    }

    /**
     * Replace a previously-seeded {@code acp:AuthenticatedAgent} owner with the configured one.
     *
     * <p>Without this the fix is unreachable on any storage that has already booted: {@link #seed}
     * returns early once the root ACR is typed, so adding {@code :LWSOwner} afterwards is silently
     * dead config and the permissive grant stays frozen in TDB2. Repairing on the next start is
     * what makes the setting mean something on a live deployment — and the manual alternative is a
     * PUT to {@code {root}.acr}, which needs Control that, in exactly this situation, every
     * authenticated stranger also holds.
     *
     * <p>Only the owner matcher's agent changes; the policies, their modes and the creator rule are
     * left alone, so an owner who has since edited the root ACR does not lose that work.
     */
    private static void repairIfUnowned(Model acp, String root, Resource ownerMatcher) {
        if (!acp.contains(ownerMatcher, ACP.agent, ACP.AuthenticatedAgent)) {
            return;   // already owned, or an owner has rewritten the root ACR themselves
        }
        String ownerWebId = requireOwner(root);
        acp.remove(acp.listStatements(ownerMatcher, ACP.agent, ACP.AuthenticatedAgent).toList());
        acp.add(ownerMatcher, ACP.agent, ResourceFactory.createResource(ownerWebId));
        LOG.warn("LWS storage {} was seeded with full control granted to ANY authenticated agent;"
                + " that grant has been replaced with the configured :LWSOwner {}. Any resource"
                + " created in the meantime kept whatever its creator was given.", root, ownerWebId);
    }

    private static Resource policy(Model acp, String uri, Resource matcher, List<AccessMode> allow) {
        Resource p = ResourceFactory.createResource(uri);
        acp.add(p, RDF.type, ACP.Policy);
        acp.add(p, ACP.allOf, matcher);
        for (AccessMode m : allow) {
            acp.add(p, ACP.allow, m.iri());
        }
        return p;
    }

    private static Resource accessControl(Model acp, String uri, Resource policy) {
        Resource ac = ResourceFactory.createResource(uri);
        acp.add(ac, RDF.type, ACP.AccessControl);
        acp.add(ac, ACP.apply, policy);
        return ac;
    }
}
