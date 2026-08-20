import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
  creerCompteSecondaire, changerMotDePasse,
} from "./firebase-config.js";

import { genererCode, formatDate, formatMontant, notifier } from "./utils.js";
import { calculerAge, calculerQuotaMembre, obtenirReglesActives } from "./bareme.js";
import { evaluerEligibiliteAssistance, genererReferenceCas } from "./casSociaux.js";

const state = {
  currentUser: null,
  associationId: null,
  association: null,
  membres: [],
  cotisations: [],
  familles: [],
  familyMembers: [],
  reaffectationsRecues: [],
  socialCases: [],
  bureauUtilisateurs: [],
  reglesActives: null,
  unsubscribers: [],
};
let creationEnCours = false;

const screens = ["screen-loading", "screen-login", "screen-inscription", "screen-dashboard"];
function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
}

// ---------- ACCÈS BUREAU (Président / Secrétaire général / Gestionnaire financier) ----------

const libellesSousRole = {
  president: "Président",
  secretaire_general: "Secrétaire général",
  gestionnaire_financier: "Gestionnaire financier",
};

const PERMISSIONS = {
  president: {
    membres: "lecture", familles: "lecture", cotisations: "lecture",
    reaffectations: "lecture", cas_sociaux: "arbitrage", utilisateurs: "gerer",
  },
  secretaire_general: {
    membres: "gerer", familles: "gerer", cotisations: "aucun",
    reaffectations: "gerer", cas_sociaux: "instruire", utilisateurs: "aucun",
  },
  gestionnaire_financier: {
    membres: "lecture", familles: "lecture", cotisations: "gerer",
    reaffectations: "aucun", cas_sociaux: "aucun", utilisateurs: "aucun",
  },
};

function sousRoleActuel() {
  return state.currentUser?.sous_role || "president";
}
function permission(module) {
  return PERMISSIONS[sousRoleActuel()]?.[module] || "aucun";
}
function casSocialActionAutorisee(statutCas) {
  const sousRole = sousRoleActuel();
  if (sousRole === "president") return statutCas === "propose";
  if (sousRole === "secretaire_general") return ["signale", "evalue", "valide", "execute"].includes(statutCas);
  return false;
}

function appliquerPermissionsInterface() {
  const gatingOnglets = {
    cotisations: permission("cotisations") === "aucun",
    reaffectations: permission("reaffectations") === "aucun",
    social: permission("cas_sociaux") === "aucun",
    utilisateurs: permission("utilisateurs") === "aucun",
  };

  Object.entries(gatingOnglets).forEach(([tab, doitCacher]) => {
    const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    const panel = document.getElementById(`tab-${tab}`);
    if (btn) btn.classList.toggle("hidden", doitCacher);
    if (panel && doitCacher) panel.classList.add("hidden");
  });

  const btnActifCache = document.querySelector(".tab-btn.active.hidden");
  if (btnActifCache) {
    const premierVisible = [...document.querySelectorAll(".tab-btn")].find((b) => !b.classList.contains("hidden"));
    if (premierVisible) premierVisible.click();
  }

  const btnNouvelleFamille = document.getElementById("btn-nouvelle-famille");
  if (btnNouvelleFamille) btnNouvelleFamille.classList.toggle("hidden", permission("familles") !== "gerer");

  const btnNouvelleCotisation = document.getElementById("btn-nouvelle-cotisation");
  if (btnNouvelleCotisation) btnNouvelleCotisation.classList.toggle("hidden", permission("cotisations") !== "gerer");

  const btnEncaisser = document.getElementById("btn-encaisser-quota-famille");
  if (btnEncaisser) btnEncaisser.classList.toggle("hidden", permission("cotisations") !== "gerer");

  const btnCodeMembre = document.getElementById("btn-nouveau-code-membre");
  if (btnCodeMembre) btnCodeMembre.classList.toggle("hidden", permission("membres") !== "gerer");

  const btnNouveauCas = document.getElementById("btn-nouveau-cas-social");
  if (btnNouveauCas) btnNouveauCas.classList.toggle("hidden", permission("cas_sociaux") === "aucun");

  const btnNouvelAcces = document.getElementById("btn-nouvel-acces-bureau");
  if (btnNouvelAcces) btnNouvelAcces.classList.toggle("hidden", permission("utilisateurs") !== "gerer");

  const tabBtnApercu = document.getElementById("tab-btn-apercu");
  if (tabBtnApercu) tabBtnApercu.textContent = `Tableau de bord — ${libellesSousRole[sousRoleActuel()]}`;
}

function demarrer() {
  showScreen("screen-loading");
  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    if (user) {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      if (userSnap.exists() && userSnap.data().role === "bureau") {
        if (userSnap.data().statut === "inactif") {
          notifier("Cet accès a été désactivé. Contactez le président de votre association.", "erreur");
          await signOut(auth);
          showScreen("screen-login");
          return;
        }
        state.currentUser = { uid: user.uid, ...userSnap.data() };
        state.associationId = userSnap.data().association_id;
        await lancerDashboard();
        return;
      } else {
        await signOut(auth);
      }
    }
    showScreen("screen-login");
  });
}

document.getElementById("lien-vers-inscription").addEventListener("click", () => {
  showScreen("screen-inscription");
});
document.getElementById("lien-retour-login").addEventListener("click", () => {
  showScreen("screen-login");
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await signInWithEmailAndPassword(auth, fd.get("email").trim(), fd.get("password"));
  } catch (err) {
    notifier("Identifiants incorrects.", "erreur");
  }
});

document.getElementById("form-inscription").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inscError = document.getElementById("inscError");
  inscError.textContent = "";
  const fd = new FormData(e.target);
  const code = fd.get("code").trim().toUpperCase();
  const nomAssociation = fd.get("nomAssociation").trim();
  const ville = fd.get("ville").trim();
  const nom = fd.get("nom").trim();
  const telephone = fd.get("telephone").trim();
  const email = fd.get("email").trim();
  const password = fd.get("password");

  if (!code.startsWith("BUR-")) {
    inscError.textContent = "Ce code ne correspond pas à un code d'invitation de coordination (BUR-...).";
    return;
  }

  creationEnCours = true;
  try {
    const codeRef = doc(db, "codes_parrainage", code);
    const codeSnap = await getDoc(codeRef);

    if (!codeSnap.exists() || codeSnap.data().type !== "bureau" || codeSnap.data().actif !== true) {
      inscError.textContent = "Code invalide, déjà utilisé, ou expiré. Contactez votre coordination.";
      creationEnCours = false;
      return;
    }

    const coordinationId = codeSnap.data().coordination_id;

    const cred = await createUserWithEmailAndPassword(auth, email, password);

    const assocRef = await addDoc(collection(db, "associations"), {
      nom: nomAssociation,
      ville,
      coordination_id: coordinationId,
      date_creation: serverTimestamp(),
      statut: "actif",
    });

    const userData = {
      role: "bureau",
      sous_role: "president",
      nom, telephone, email,
      association_id: assocRef.id,
      coordination_id: coordinationId,
      statut: "actif",
      date_creation: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), userData);
    await updateDoc(codeRef, { actif: false, utilise_par: cred.user.uid });

    notifier("Association créée avec succès. Vous êtes enregistré comme Président.", "succes");
    state.currentUser = { uid: cred.user.uid, ...userData };
    state.associationId = assocRef.id;
    creationEnCours = false;
    await lancerDashboard();
  } catch (err) {
    notifier("Erreur : " + err.message, "erreur");
    if (auth.currentUser) {
      try { await auth.currentUser.delete(); } catch (e2) { /* ignore */ }
      try { await signOut(auth); } catch (e3) { /* ignore */ }
    }
    creationEnCours = false;
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  state.unsubscribers.forEach((u) => u());
  state.unsubscribers = [];
  await signOut(auth);
  showScreen("screen-login");
});

document.getElementById("btn-changer-mdp").addEventListener("click", () => {
  ouvrirModal(`
    <h2>Changer mon mot de passe</h2>
    <p class="subtitle-sm">Confirmez votre mot de passe actuel puis saisissez le nouveau.</p>
    <form id="form-changer-mdp">
      <div class="field-row">
        <label>Mot de passe actuel</label>
        <input type="password" name="ancien" required />
      </div>
      <div class="field-row">
        <label>Nouveau mot de passe (6 caractères min)</label>
        <input type="password" name="nouveau" minlength="6" required />
      </div>
      <div class="field-row">
        <label>Confirmer le nouveau mot de passe</label>
        <input type="password" name="confirmation" minlength="6" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-changer-mdp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ancien = fd.get("ancien");
    const nouveau = fd.get("nouveau");
    const confirmation = fd.get("confirmation");
    if (nouveau !== confirmation) {
      notifier("Les deux mots de passe ne correspondent pas.", "erreur");
      return;
    }
    try {
      await changerMotDePasse(state.currentUser.email, ancien, nouveau);
      notifier("Mot de passe modifié avec succès.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Mot de passe actuel incorrect ou erreur : " + err.message, "erreur");
    }
  });
});

async function lancerDashboard() {
  showScreen("screen-dashboard");
  const assocSnap = await getDoc(doc(db, "associations", state.associationId));
  if (assocSnap.exists()) {
    state.association = assocSnap.data();
    document.getElementById("db-association-nom").textContent = state.association.nom;
  }
  document.getElementById("db-bureau-nom").textContent =
    `${state.currentUser.nom} (${libellesSousRole[sousRoleActuel()]})`;

  appliquerPermissionsInterface();

  state.reglesActives = await obtenirReglesActives(state.associationId);

  const unsubMembres = onSnapshot(
    query(collection(db, "users"), where("association_id", "==", state.associationId), where("role", "==", "membre")),
    (snap) => {
      state.membres = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      render();
    }
  );
  const unsubCotisations = onSnapshot(
    query(collection(db, "cotisations"), where("association_id", "==", state.associationId)),
    (snap) => {
      state.cotisations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubFamilles = onSnapshot(
    query(collection(db, "families"), where("association_id", "==", state.associationId)),
    (snap) => {
      state.familles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubFamilyMembers = onSnapshot(
    query(collection(db, "family_members"), where("association_id", "==", state.associationId)),
    (snap) => {
      state.familyMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubReaffectations = onSnapshot(
    query(
      collection(db, "reaffectations"),
      where("association_destination_id", "==", state.associationId),
      where("statut", "==", "transmis")
    ),
    (snap) => {
      state.reaffectationsRecues = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubSocialCases = onSnapshot(
    query(collection(db, "social_cases"), where("association_id", "==", state.associationId)),
    (snap) => {
      state.socialCases = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubUtilisateursBureau = onSnapshot(
    query(collection(db, "users"), where("association_id", "==", state.associationId), where("role", "==", "bureau")),
    (snap) => {
      state.bureauUtilisateurs = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      renderUtilisateursBureau();
      renderApercu();
    }
  );
  state.unsubscribers.push(
    unsubMembres, unsubCotisations, unsubFamilles, unsubFamilyMembers,
    unsubReaffectations, unsubSocialCases, unsubUtilisateursBureau
  );
}

function render() {
  renderApercu();
  renderMembres();
  renderFamilles();
  renderCotisations();
  renderReaffectations();
  renderCasSociaux();
}

// ---------- APERÇU (page d'accueil spécifique à chaque rôle) ----------

function computeFinanceStats() {
  const total = state.cotisations.reduce((s, c) => s + Number(c.montant || 0), 0);
  const maintenant = new Date();
  const moisActuel = maintenant.getMonth();
  const anneeActuelle = maintenant.getFullYear();
  const cotisationsMois = state.cotisations.filter((c) => {
    if (!c.date || !c.date.toDate) return false;
    const d = c.date.toDate();
    return d.getMonth() === moisActuel && d.getFullYear() === anneeActuelle;
  });
  const totalMois = cotisationsMois.reduce((s, c) => s + Number(c.montant || 0), 0);
  const famillesAyantPayeCeMois = new Set(cotisationsMois.map((c) => c.famille_id));
  return {
    total,
    totalMois,
    nbFamillesAJour: famillesAyantPayeCeMois.size,
    nbFamillesEnRetard: Math.max(state.familles.length - famillesAyantPayeCeMois.size, 0),
  };
}

function renderApercu() {
  const container = document.getElementById("apercu-container");
  if (!container) return;
  const sousRole = sousRoleActuel();
  if (sousRole === "secretaire_general") {
    renderApercuSecretaire(container);
  } else if (sousRole === "gestionnaire_financier") {
    renderApercuGestionnaireFinancier(container);
  } else {
    renderApercuPresident(container);
  }
}

function renderApercuPresident(container) {
  const finance = computeFinanceStats();
  const casEnCours = state.socialCases.filter((c) => !["cloture", "rejete"].includes(c.statut));
  const casAArbitrer = state.socialCases.filter((c) => c.statut === "propose");
  const accesActifs = state.bureauUtilisateurs.filter((u) => u.sous_role && u.sous_role !== "president" && u.statut === "actif");

  container.innerHTML = `
    <p class="subtitle-sm" style="margin-bottom:14px;">Vue d'ensemble du Président : supervision de l'association, arbitrage des cas sociaux majeurs, gestion des accès du bureau.</p>
    <div class="cards-grid">
      <div class="stat-card"><p class="stat-label">Familles enregistrées</p><p class="stat-value">${state.familles.length}</p></div>
      <div class="stat-card"><p class="stat-label">Membres actifs</p><p class="stat-value">${state.membres.filter((m) => m.statut === "actif").length}</p></div>
      <div class="stat-card"><p class="stat-label">Solde de la caisse</p><p class="stat-value">${formatMontant(finance.total)}</p></div>
      <div class="stat-card"><p class="stat-label">Cas sociaux en cours</p><p class="stat-value">${casEnCours.length}</p></div>
    </div>

    <h3 style="margin:20px 0 8px; font-size:14px;">Dossiers en attente de votre arbitrage</h3>
    ${casAArbitrer.length === 0
      ? `<p class="empty-state">Aucun dossier en attente de validation présidentielle.</p>`
      : casAArbitrer.map((c) => `
        <div class="entity-card" data-cas-id="${c.id}" style="cursor:pointer;">
          <div class="entity-card-top">
            <div>
              <p class="entity-nom">${c.beneficiaire_nom}</p>
              <p class="entity-sub">${c.famille_nom || ""} · ${formatMontant(c.montant_propose)}</p>
            </div>
            <span class="badge badge-erreur">À valider</span>
          </div>
        </div>
      `).join("")}

    <h3 style="margin:20px 0 8px; font-size:14px;">Accès du bureau</h3>
    <p class="subtitle-sm">${accesActifs.length} accès actif(s) en plus du vôtre (Secrétaire général / Gestionnaire financier).</p>
    <button type="button" class="btn btn-secondary btn-sm" id="raccourci-gerer-acces">Gérer les accès</button>
  `;

  container.querySelectorAll("[data-cas-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalCasSocial(card.dataset.casId));
  });
  document.getElementById("raccourci-gerer-acces")?.addEventListener("click", () => {
    document.querySelector('.tab-btn[data-tab="utilisateurs"]')?.click();
  });
}

function renderApercuSecretaire(container) {
  const profilsIncomplets = state.membres.filter((m) => calculerAge(m.date_naissance) === null || !m.sexe);
  const casAInstruire = state.socialCases.filter((c) => ["signale", "evalue", "valide", "execute"].includes(c.statut));

  container.innerHTML = `
    <p class="subtitle-sm" style="margin-bottom:14px;">Vue d'ensemble du Secrétaire général : tenue des membres et familles, instruction des cas sociaux, intégration des réaffectations.</p>
    <div class="cards-grid">
      <div class="stat-card"><p class="stat-label">Familles enregistrées</p><p class="stat-value">${state.familles.length}</p></div>
      <div class="stat-card"><p class="stat-label">Membres actifs</p><p class="stat-value">${state.membres.filter((m) => m.statut === "actif").length}</p></div>
      <div class="stat-card"><p class="stat-label">Profils incomplets</p><p class="stat-value">${profilsIncomplets.length}</p></div>
      <div class="stat-card"><p class="stat-label">Réaffectations à intégrer</p><p class="stat-value">${state.reaffectationsRecues.length}</p></div>
    </div>

    <h3 style="margin:20px 0 8px; font-size:14px;">Cas sociaux à instruire</h3>
    ${casAInstruire.length === 0
      ? `<p class="empty-state">Aucun dossier social à instruire pour l'instant.</p>`
      : casAInstruire.map((c) => `
        <div class="entity-card" data-cas-id="${c.id}" style="cursor:pointer;">
          <div class="entity-card-top">
            <div>
              <p class="entity-nom">${c.beneficiaire_nom}</p>
              <p class="entity-sub">${c.famille_nom || ""} · ${libellesStatutCas[c.statut] || c.statut}</p>
            </div>
          </div>
        </div>
      `).join("")}

    <h3 style="margin:20px 0 8px; font-size:14px;">Actions rapides</h3>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary btn-sm" id="raccourci-nouvelle-famille">+ Créer une famille</button>
      <button type="button" class="btn btn-secondary btn-sm" id="raccourci-code-membre">+ Générer un code membre</button>
    </div>
  `;

  container.querySelectorAll("[data-cas-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalCasSocial(card.dataset.casId));
  });
  document.getElementById("raccourci-nouvelle-famille")?.addEventListener("click", () => {
    document.querySelector('.tab-btn[data-tab="familles"]')?.click();
    document.getElementById("btn-nouvelle-famille")?.click();
  });
  document.getElementById("raccourci-code-membre")?.addEventListener("click", () => {
    document.querySelector('.tab-btn[data-tab="membres"]')?.click();
    document.getElementById("btn-nouveau-code-membre")?.click();
  });
}

function renderApercuGestionnaireFinancier(container) {
  const finance = computeFinanceStats();

  container.innerHTML = `
    <p class="subtitle-sm" style="margin-bottom:14px;">Vue d'ensemble du Gestionnaire financier : caisse, cotisations et encaissements.</p>
    <div class="cards-grid">
      <div class="stat-card"><p class="stat-label">Solde de la caisse</p><p class="stat-value">${formatMontant(finance.total)}</p></div>
      <div class="stat-card"><p class="stat-label">Cotisations ce mois</p><p class="stat-value">${formatMontant(finance.totalMois)}</p></div>
      <div class="stat-card"><p class="stat-label">Familles à jour ce mois</p><p class="stat-value">${finance.nbFamillesAJour}</p></div>
      <div class="stat-card"><p class="stat-label">Familles en retard</p><p class="stat-value">${finance.nbFamillesEnRetard}</p></div>
    </div>

    <h3 style="margin:20px 0 8px; font-size:14px;">Actions rapides</h3>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="btn btn-primary btn-sm" id="raccourci-encaisser">+ Encaisser le quota d'une famille</button>
      <button type="button" class="btn btn-secondary btn-sm" id="raccourci-paiement-libre">+ Paiement libre</button>
    </div>
  `;

  document.getElementById("raccourci-encaisser")?.addEventListener("click", () => {
    document.querySelector('.tab-btn[data-tab="cotisations"]')?.click();
    document.getElementById("btn-encaisser-quota-famille")?.click();
  });
  document.getElementById("raccourci-paiement-libre")?.addEventListener("click", () => {
    document.querySelector('.tab-btn[data-tab="cotisations"]')?.click();
    document.getElementById("btn-nouvelle-cotisation")?.click();
  });
}

// ---------- MEMBRES (comptes = chefs de famille ou en attente) ----------

function renderMembres() {
  const recherche = (document.getElementById("recherche-membres").value || "").toLowerCase();
  let membres = state.membres;
  if (recherche) {
    membres = membres.filter((m) => m.nom.toLowerCase().includes(recherche) || (m.telephone || "").includes(recherche));
  }

  const container = document.getElementById("liste-membres");
  if (membres.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun membre trouvé.</p>`;
    return;
  }
  container.innerHTML = membres.map((m) => {
    const age = calculerAge(m.date_naissance);
    const famille = state.familles.find((f) => f.chef_membre_id === m.uid);
    const profilIncomplet = age === null || !m.sexe;
    return `
      <div class="entity-card" data-membre-id="${m.uid}" style="cursor:pointer;">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom}</p>
            <p class="entity-sub">${m.telephone || ""} · ${m.residence || ""}</p>
            <p class="entity-sub" style="margin-top:2px;">
              ${age !== null ? age + " ans" : '<span style="color:#c0392b;">Âge non renseigné</span>'}
              ${famille ? " · Chef de : " + (famille.nom_famille || "sa famille") : " · Pas encore chef de famille"}
              ${profilIncomplet ? ' · <span style="color:#c0392b;">Profil incomplet</span>' : ""}
            </p>
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-membre-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalProfilMembre(card.dataset.membreId));
  });
}
document.getElementById("recherche-membres").addEventListener("input", renderMembres);

function ouvrirModalProfilMembre(membreId) {
  const m = state.membres.find((x) => x.uid === membreId);
  if (!m) return;

  const peutModifier = permission("membres") === "gerer";

  if (!peutModifier) {
    ouvrirModal(`
      <h2>${m.nom}</h2>
      <p class="subtitle-sm">Consultation seule — la modification du profil est réservée au Secrétaire général.</p>
      <div class="field-row"><label>Téléphone</label><p>${m.telephone || "—"}</p></div>
      <div class="field-row"><label>Résidence</label><p>${m.residence || "—"}</p></div>
      <div class="field-row"><label>Date de naissance</label><p>${m.date_naissance || "—"}</p></div>
      <div class="field-row"><label>Sexe</label><p>${m.sexe === "M" ? "Masculin" : m.sexe === "F" ? "Féminin" : "—"}</p></div>
      <div class="field-row"><label>Situation matrimoniale</label><p>${m.situation_matrimoniale === "marie" ? "Marié(e)" : "Célibataire"}</p></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" id="modal-annuler" style="flex:1;">Fermer</button>
      </div>
    `);
    document.getElementById("modal-annuler").addEventListener("click", fermerModal);
    return;
  }

  ouvrirModal(`
    <h2>${m.nom}</h2>
    <p class="subtitle-sm">Complétez le profil pour permettre le calcul automatique du quota.</p>
    <form id="form-profil-membre">
      <div class="field-row">
        <label>Date de naissance</label>
        <input type="date" name="date_naissance" value="${m.date_naissance || ""}" required />
      </div>
      <div class="field-row">
        <label>Sexe</label>
        <select name="sexe" required>
          <option value="">—</option>
          <option value="M" ${m.sexe === "M" ? "selected" : ""}>Masculin</option>
          <option value="F" ${m.sexe === "F" ? "selected" : ""}>Féminin</option>
        </select>
      </div>
      <div class="field-row">
        <label>Situation matrimoniale</label>
        <select name="situation_matrimoniale" required>
          <option value="celibataire" ${m.situation_matrimoniale !== "marie" ? "selected" : ""}>Célibataire</option>
          <option value="marie" ${m.situation_matrimoniale === "marie" ? "selected" : ""}>Marié(e)</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-profil-membre").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await updateDoc(doc(db, "users", membreId), {
        date_naissance: fd.get("date_naissance"),
        sexe: fd.get("sexe"),
        situation_matrimoniale: fd.get("situation_matrimoniale"),
      });
      notifier("Profil mis à jour.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

// ---------- FAMILLES ----------

function dependantsActifs(familleId) {
  return state.familyMembers.filter((fm) => fm.family_id === familleId && fm.statut !== "retire");
}

function totalQuotaFamille(f) {
  const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
  let total = 0;
  if (chef) {
    const q = calculerQuotaMembre(chef, state.reglesActives);
    if (q.applique) total += q.montant;
  }
  dependantsActifs(f.id).forEach((fm) => {
    const q = calculerQuotaMembre(fm, state.reglesActives);
    if (q.applique) total += q.montant;
  });
  return total;
}

function renderFamilles() {
  const container = document.getElementById("liste-familles");
  if (state.familles.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune famille enregistrée pour l'instant.</p>`;
    return;
  }
  container.innerHTML = state.familles.map((f) => {
    const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
    const nbDependants = dependantsActifs(f.id).length;
    const enAttenteChef = !f.chef_membre_id;
    return `
      <div class="entity-card" data-famille-id="${f.id}" style="cursor:pointer;">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${f.nom_famille || "Famille " + (chef ? chef.nom : "?")}</p>
            <p class="entity-sub">Chef : ${chef ? chef.nom : (enAttenteChef ? "En attente d'inscription du chef" : "—")} · ${nbDependants} personne(s) à charge</p>
          </div>
          <span class="badge badge-actif">${formatMontant(totalQuotaFamille(f))}</span>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-famille-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalFamille(card.dataset.familleId));
  });
}

document.getElementById("btn-nouvelle-famille").addEventListener("click", () => {
  if (permission("familles") !== "gerer") return;
  const chefsDisponibles = state.membres.filter((m) => !state.familles.some((f) => f.chef_membre_id === m.uid));
  if (chefsDisponibles.length === 0) {
    notifier("Aucun membre disponible pour devenir chef de famille. Générez d'abord un code membre.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Créer une famille</h2>
    <p class="subtitle-sm">Le chef de famille doit déjà posséder un compte membre.</p>
    <form id="form-nouvelle-famille">
      <div class="field-row">
        <label>Nom de la famille (optionnel)</label>
        <input type="text" name="nom_famille" placeholder="Ex : Famille Camara" />
      </div>
      <div class="field-row">
        <label>Chef de famille</label>
        <select name="chef_membre_id" required>
          ${chefsDisponibles.map((m) => `<option value="${m.uid}">${m.nom}</option>`).join("")}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Créer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-nouvelle-famille").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const chefId = fd.get("chef_membre_id");
    try {
      const familleRef = await addDoc(collection(db, "families"), {
        association_id: state.associationId,
        nom_famille: fd.get("nom_famille").trim(),
        chef_membre_id: chefId,
        statut: "active",
        date_creation: serverTimestamp(),
      });
      await updateDoc(doc(db, "users", chefId), { family_id: familleRef.id });
      notifier("Famille créée.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
});

function ouvrirModalFamille(familleId) {
  const f = state.familles.find((x) => x.id === familleId);
  if (!f) return;
  const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
  const dependants = dependantsActifs(f.id);
  const peutGerer = permission("familles") === "gerer";

  const ligneChef = chef ? (() => {
    const q = calculerQuotaMembre(chef, state.reglesActives);
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${chef.nom} (chef)</p>
            <p class="entity-sub">${q.formule}</p>
          </div>
          <span class="badge badge-actif">${q.applique ? formatMontant(q.montant) : "—"}</span>
        </div>
      </div>
    `;
  })() : `<p class="empty-state">Chef non encore inscrit.</p>`;

  const lignesDependants = dependants.map((fm) => {
    const q = calculerQuotaMembre(fm, state.reglesActives);
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${fm.nom}</p>
            <p class="entity-sub">${q.formule}</p>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="badge badge-actif">${q.applique ? formatMontant(q.montant) : "—"}</span>
            ${peutGerer ? `<button type="button" class="btn btn-ghost-sm btn-retirer-dependant" data-id="${fm.id}">Retirer</button>` : ""}
          </div>
        </div>
      </div>
    `;
  }).join("");

  ouvrirModal(`
    <h2>${f.nom_famille || "Famille " + (chef ? chef.nom : "?")}</h2>
    <p class="subtitle-sm">Total quota famille : <strong>${formatMontant(totalQuotaFamille(f))}</strong></p>
    <h3 style="margin-top:14px; font-size:14px;">Chef</h3>
    ${ligneChef}
    <h3 style="margin-top:14px; font-size:14px;">Personnes à charge</h3>
    <div>${lignesDependants || '<p class="empty-state">Aucune personne déclarée.</p>'}</div>
    ${peutGerer ? `
    <hr style="margin:16px 0; border:none; border-top:1px solid #eee;" />
    <form id="form-ajouter-dependant">
      <p class="subtitle-sm">Déclarer un nouveau membre de cette famille</p>
      <div class="field-row">
        <label>Nom complet</label>
        <input type="text" name="nom" required />
      </div>
      <div class="field-row">
        <label>Date de naissance</label>
        <input type="date" name="date_naissance" required />
      </div>
      <div class="field-row">
        <label>Sexe</label>
        <select name="sexe" required>
          <option value="">—</option>
          <option value="M">Masculin</option>
          <option value="F">Féminin</option>
        </select>
      </div>
      <div class="field-row">
        <label>Situation matrimoniale</label>
        <select name="situation_matrimoniale" required>
          <option value="celibataire">Célibataire</option>
          <option value="marie">Marié(e)</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Ajouter</button>
      </div>
    </form>
    ` : `
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="btn btn-primary" id="modal-annuler" style="flex:1;">Fermer</button>
    </div>
    `}
  `);

  document.getElementById("modal-annuler").addEventListener("click", fermerModal);

  if (!peutGerer) return;

  document.querySelectorAll(".btn-retirer-dependant").forEach((btn) => {
    btn.addEventListener("click", () => ouvrirModalRetraitDependant(btn.dataset.id, familleId));
  });

  document.getElementById("form-ajouter-dependant").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await addDoc(collection(db, "family_members"), {
        association_id: state.associationId,
        family_id: familleId,
        nom: fd.get("nom").trim(),
        date_naissance: fd.get("date_naissance"),
        sexe: fd.get("sexe"),
        situation_matrimoniale: fd.get("situation_matrimoniale"),
        statut: "actif",
        date_creation: serverTimestamp(),
      });
      notifier("Membre de famille déclaré.", "succes");
      ouvrirModalFamille(familleId);
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

function calculerTauxRetardFamille(familleId) {
  const maintenant = new Date();
  const periodesPayees = new Set();
  state.cotisations
    .filter((c) => c.famille_id === familleId && c.periode)
    .forEach((c) => periodesPayees.add(c.periode));

  let moisPayesSur12 = 0;
  for (let i = 0; i < 12; i++) {
    const d = new Date(maintenant.getFullYear(), maintenant.getMonth() - i, 1);
    const cle = d.toISOString().slice(0, 7);
    if (periodesPayees.has(cle)) moisPayesSur12++;
  }
  return Math.round((1 - moisPayesSur12 / 12) * 100);
}

function ouvrirModalRetraitDependant(dependantId, familleId) {
  const fm = state.familyMembers.find((x) => x.id === dependantId);
  if (!fm) return;

  ouvrirModal(`
    <h2>Retirer ${fm.nom}</h2>
    <form id="form-retrait-dependant">
      <div class="field-row">
        <label>Motif du retrait</label>
        <select name="motif" id="select-motif-retrait" required>
          <option value="">—</option>
          <option value="mariage">Mariage / départ du foyer, devient indépendant</option>
          <option value="voyage">Voyage</option>
          <option value="demenagement">Déménagement définitif dans une autre ville</option>
          <option value="deces">Décès</option>
        </select>
      </div>
      <div class="field-row hidden" id="champ-ville-destination">
        <label>Ville de destination</label>
        <input type="text" name="ville_destination" placeholder="Ex : Kankan" />
      </div>
      <p class="subtitle-sm" id="note-motif"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer le retrait</button>
      </div>
    </form>
  `);

  document.getElementById("modal-annuler").addEventListener("click", () => ouvrirModalFamille(familleId));

  const select = document.getElementById("select-motif-retrait");
  const champVille = document.getElementById("champ-ville-destination");
  const note = document.getElementById("note-motif");
  select.addEventListener("change", () => {
    const v = select.value;
    champVille.classList.toggle("hidden", v !== "voyage" && v !== "demenagement");
    if (v === "mariage") {
      note.textContent = "Une nouvelle famille sera créée à son nom, avec un code d'inscription à lui transmettre.";
    } else if (v === "voyage" || v === "demenagement") {
      note.textContent = "Son dossier sera transmis à la coordination pour réaffectation dans sa ville d'accueil.";
    } else if (v === "deces") {
      note.textContent = "La personne sera retirée définitivement des effectifs.";
    } else {
      note.textContent = "";
    }
  });

  document.getElementById("form-retrait-dependant").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const motif = fd.get("motif");
    const villeDestination = (fd.get("ville_destination") || "").trim();

    if ((motif === "voyage" || motif === "demenagement") && !villeDestination) {
      notifier("Veuillez indiquer la ville de destination.", "erreur");
      return;
    }

    try {
      await updateDoc(doc(db, "family_members", dependantId), {
        statut: "retire",
        motif_retrait: motif,
        date_retrait: serverTimestamp(),
        ...(villeDestination ? { ville_destination: villeDestination } : {}),
      });

      if (motif === "mariage") {
        const nouvelleFamilleRef = await addDoc(collection(db, "families"), {
          association_id: state.associationId,
          nom_famille: fm.nom,
          chef_membre_id: null,
          chef_nom_prevu: fm.nom,
          en_attente_chef: true,
          statut: "active",
          date_creation: serverTimestamp(),
        });

        const code = genererCode("MBR");
        await setDoc(doc(db, "codes_parrainage", code), {
          type: "membre",
          association_id: state.associationId,
          coordination_id: state.currentUser.coordination_id,
          proprietaire_id: state.currentUser.uid,
          family_id_cible: nouvelleFamilleRef.id,
          actif: true,
          date_creation: serverTimestamp(),
        });

        notifier("Retiré. Nouvelle famille créée.", "succes");
        ouvrirModal(`
          <h2>Code généré pour ${fm.nom}</h2>
          <p class="subtitle-sm">Transmettez ce code à cette personne pour qu'elle crée son propre compte et devienne chef de sa nouvelle famille sur l'application Membre.</p>
          <div class="code-display">${code}</div>
          <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-code" style="flex:1;">Terminé</button></div>
        `);
        document.getElementById("modal-fermer-code").addEventListener("click", fermerModal);
        return;
      }

      if (motif === "voyage" || motif === "demenagement") {
        const tauxRetard = calculerTauxRetardFamille(familleId);
        await addDoc(collection(db, "reaffectations"), {
          coordination_id: state.currentUser.coordination_id,
          association_origine_id: state.associationId,
          association_origine_nom: state.association ? state.association.nom : "",
          nom: fm.nom,
          date_naissance: fm.date_naissance || null,
          sexe: fm.sexe || null,
          situation_matrimoniale: fm.situation_matrimoniale || null,
          motif,
          ville_destination: villeDestination,
          historique_estime: {
            taux_retard_paiement_famille_pourcent: tauxRetard,
            frequentation_cas_sociaux_pourcent: null,
            note: "Taux de retard estimé au niveau de la famille d'origine (les paiements ne sont pas suivis individuellement). La fréquentation des cas sociaux sera disponible une fois ce module actif.",
          },
          statut: "en_attente",
          date_creation: serverTimestamp(),
        });
        notifier("Retiré. Dossier transmis à la coordination pour réaffectation.", "succes");
        fermerModal();
        return;
      }

      notifier("Retiré des effectifs.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

// ---------- COTISATIONS ----------

function renderCotisations() {
  const container = document.getElementById("liste-cotisations");
  if (state.cotisations.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune cotisation enregistrée pour l'instant.</p>`;
    return;
  }
  const libellesType = {
    quota: "Quota (barème)",
    volontaire: "Contribution volontaire",
    libre: "Paiement libre",
  };
  const tri = [...state.cotisations].sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
  container.innerHTML = tri.slice(0, 50).map((c) => {
    const famille = state.familles.find((f) => f.id === c.famille_id);
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${c.membre_nom || "—"} ${famille ? "(" + (famille.nom_famille || "famille") + ")" : ""}</p>
            <p class="entity-sub">${libellesType[c.type] || c.type} · ${formatDate(c.date)}</p>
          </div>
          <span class="badge badge-actif">${formatMontant(c.montant)}</span>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("btn-nouvelle-cotisation").addEventListener("click", () => {
  if (permission("cotisations") !== "gerer") return;
  const membresActifs = state.membres.filter((m) => m.statut === "actif");
  if (membresActifs.length === 0) {
    notifier("Aucun membre actif pour enregistrer un paiement.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Paiement libre</h2>
    <p class="subtitle-sm">À utiliser pour une correction ou un cas particulier hors barème.</p>
    <form id="form-cotisation">
      <div class="field-row">
        <label>Chef de famille</label>
        <select name="membre_id" required>
          ${membresActifs.map((m) => `<option value="${m.uid}">${m.nom}</option>`).join("")}
        </select>
      </div>
      <div class="field-row">
        <label>Montant (GNF)</label>
        <input type="number" name="montant" min="1" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-cotisation").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const membreId = fd.get("membre_id");
    const membre = state.membres.find((m) => m.uid === membreId);
    const famille = state.familles.find((f) => f.chef_membre_id === membreId);
    try {
      await addDoc(collection(db, "cotisations"), {
        association_id: state.associationId,
        famille_id: famille ? famille.id : null,
        membre_id: membreId,
        membre_nom: membre ? membre.nom : "",
        type: "libre",
        montant: Number(fd.get("montant")),
        enregistre_par: state.currentUser.uid,
        date: serverTimestamp(),
      });
      notifier("Paiement enregistré.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
});

document.getElementById("btn-encaisser-quota-famille").addEventListener("click", () => {
  if (permission("cotisations") !== "gerer") return;
  if (state.familles.length === 0) {
    notifier("Aucune famille enregistrée.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Encaisser le quota d'une famille</h2>
    <form id="form-choix-famille">
      <div class="field-row">
        <label>Famille</label>
        <select name="famille_id" required>
          ${state.familles.map((f) => {
            const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
            return `<option value="${f.id}">${f.nom_famille || "Famille " + (chef ? chef.nom : "?")}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Continuer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-choix-famille").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    ouvrirModalEncaissementFamille(fd.get("famille_id"));
  });
});

function ouvrirModalEncaissementFamille(familleId) {
  const f = state.familles.find((x) => x.id === familleId);
  const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
  const dependants = dependantsActifs(familleId);

  if (!chef && dependants.length === 0) {
    notifier("Cette famille n'a aucune personne rattachée.", "erreur");
    return;
  }

  const periodeParDefaut = new Date().toISOString().slice(0, 7);

  const personnes = [];
  if (chef) personnes.push({ id: chef.uid, nom: chef.nom, type: "chef", data: chef });
  dependants.forEach((fm) => personnes.push({ id: fm.id, nom: fm.nom, type: "dependant", data: fm }));

  const lignes = personnes.map((p) => {
    const q = calculerQuotaMembre(p.data, state.reglesActives);
    if (q.applique) {
      return `
        <div class="field-row" data-ligne data-id="${p.id}" data-nom="${p.nom}" data-type="quota" data-montant="${q.montant}">
          <label>${p.nom} — ${q.formule}</label>
          <p style="font-weight:600;">${formatMontant(q.montant)}</p>
        </div>
      `;
    }
    return `
      <div class="field-row" data-ligne data-id="${p.id}" data-nom="${p.nom}" data-type="volontaire">
        <label>${p.nom} — ${q.formule}</label>
        <input type="number" min="0" placeholder="Montant (laisser vide si aucun paiement)" data-input-volontaire />
      </div>
    `;
  }).join("");

  ouvrirModal(`
    <h2>${f.nom_famille || "Famille"}</h2>
    <p class="subtitle-sm">Le chef paie le quota de toute sa famille.</p>
    <form id="form-encaissement-famille">
      <div class="field-row">
        <label>Période</label>
        <input type="month" name="periode" value="${periodeParDefaut}" required />
      </div>
      <hr style="margin:12px 0; border:none; border-top:1px solid #eee;" />
      ${lignes}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Encaisser</button>
      </div>
    </form>
  `);

  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-encaissement-famille").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const periode = fd.get("periode");
    const lignesEl = document.querySelectorAll("[data-ligne]");

    const operations = [];
    lignesEl.forEach((ligne) => {
      const type = ligne.dataset.type;
      if (type === "quota") {
        operations.push({ nom: ligne.dataset.nom, type: "quota", montant: Number(ligne.dataset.montant) });
      } else {
        const input = ligne.querySelector("[data-input-volontaire]");
        const val = Number(input.value);
        if (val > 0) operations.push({ nom: ligne.dataset.nom, type: "volontaire", montant: val });
      }
    });

    if (operations.length === 0) {
      notifier("Aucun montant à encaisser.", "erreur");
      return;
    }

    try {
      for (const op of operations) {
        await addDoc(collection(db, "cotisations"), {
          association_id: state.associationId,
          famille_id: familleId,
          periode,
          membre_id: chef ? chef.uid : null,
          membre_nom: op.nom,
          type: op.type,
          montant: op.montant,
          enregistre_par: state.currentUser.uid,
          date: serverTimestamp(),
        });
      }
      notifier("Quota de la famille encaissé.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

document.getElementById("btn-nouveau-code-membre").addEventListener("click", async () => {
  if (permission("membres") !== "gerer") return;
  const code = genererCode("MBR");
  try {
    await setDoc(doc(db, "codes_parrainage", code), {
      type: "membre",
      association_id: state.associationId,
      coordination_id: state.currentUser.coordination_id,
      proprietaire_id: state.currentUser.uid,
      actif: true,
      date_creation: serverTimestamp(),
    });
    ouvrirModal(`
      <h2>Code généré</h2>
      <p class="subtitle-sm">Transmettez ce code à un futur chef de famille. Il devra le saisir lors de son inscription sur l'application Membre.</p>
      <div class="code-display">${code}</div>
      <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-code" style="flex:1;">Terminé</button></div>
    `);
    document.getElementById("modal-fermer-code").addEventListener("click", fermerModal);
  } catch (err) {
    notifier("Erreur : " + err.message, "erreur");
  }
});

// ---------- RÉAFFECTATIONS REÇUES ----------

const libellesMotif = {
  voyage: "Voyage",
  demenagement: "Déménagement définitif",
};

function renderReaffectations() {
  const badge = document.getElementById("badge-reaffectations");
  if (state.reaffectationsRecues.length > 0) {
    badge.textContent = state.reaffectationsRecues.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  const container = document.getElementById("liste-reaffectations");
  if (state.reaffectationsRecues.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune personne à intégrer pour l'instant.</p>`;
    return;
  }

  container.innerHTML = state.reaffectationsRecues.map((r) => `
    <div class="entity-card" data-reaffectation-id="${r.id}" style="cursor:pointer;">
      <div class="entity-card-top">
        <div>
          <p class="entity-nom">${r.nom}</p>
          <p class="entity-sub">En provenance de : ${r.association_origine_nom || "—"} · ${libellesMotif[r.motif] || r.motif}</p>
        </div>
        <span class="badge badge-erreur">À intégrer</span>
      </div>
    </div>
  `).join("");

  container.querySelectorAll("[data-reaffectation-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalIntegrationReaffectation(card.dataset.reaffectationId));
  });
}

function ouvrirModalIntegrationReaffectation(reaffectationId) {
  const r = state.reaffectationsRecues.find((x) => x.id === reaffectationId);
  if (!r) return;
  const h = r.historique_estime || {};
  const peutIntegrer = permission("reaffectations") === "gerer";

  ouvrirModal(`
    <h2>${r.nom}</h2>
    <p class="subtitle-sm">Envoyé par : ${r.association_origine_nom || "—"} (${libellesMotif[r.motif] || r.motif})</p>
    <div style="margin:14px 0;">
      <div class="field-row"><label>Date de naissance</label><p>${r.date_naissance || "—"}</p></div>
      <div class="field-row"><label>Sexe</label><p>${r.sexe === "M" ? "Masculin" : r.sexe === "F" ? "Féminin" : "—"}</p></div>
      <div class="field-row"><label>Situation matrimoniale</label><p>${r.situation_matrimoniale === "marie" ? "Marié(e)" : "Célibataire"}</p></div>
      <div class="field-row"><label>Retard de paiement estimé (famille d'origine)</label><p>${h.taux_retard_paiement_famille_pourcent != null ? h.taux_retard_paiement_famille_pourcent + " %" : "—"}</p></div>
      <div class="field-row"><label>Fréquentation des cas sociaux</label><p>${h.frequentation_cas_sociaux_pourcent != null ? h.frequentation_cas_sociaux_pourcent + " %" : "Non disponible (module à venir)"}</p></div>
    </div>
    <hr style="margin:16px 0; border:none; border-top:1px solid #eee;" />
    ${peutIntegrer ? `
    <p class="subtitle-sm" style="font-weight:600;">Comment intégrer cette personne ?</p>
    <div class="modal-actions" style="flex-direction:column; gap:8px;">
      <button type="button" class="btn btn-secondary" id="btn-rattacher-famille-existante" style="width:100%;">Rattacher à une famille existante</button>
      <button type="button" class="btn btn-secondary" id="btn-devient-chef" style="width:100%;">Devient chef d'une nouvelle famille</button>
      <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="width:100%;">Annuler</button>
    </div>
    ` : `
    <p class="subtitle-sm">Seul le Secrétaire général peut intégrer ce dossier.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" id="modal-annuler" style="flex:1;">Fermer</button>
    </div>
    `}
  `);

  document.getElementById("modal-annuler").addEventListener("click", fermerModal);

  if (!peutIntegrer) return;

  document.getElementById("btn-rattacher-famille-existante").addEventListener("click", () => {
    if (state.familles.length === 0) {
      notifier("Aucune famille existante dans votre association.", "erreur");
      return;
    }
    ouvrirModal(`
      <h2>Rattacher ${r.nom}</h2>
      <form id="form-rattacher">
        <div class="field-row">
          <label>Famille</label>
          <select name="famille_id" required>
            ${state.familles.map((f) => {
              const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
              return `<option value="${f.id}">${f.nom_famille || "Famille " + (chef ? chef.nom : "?")}</option>`;
            }).join("")}
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Retour</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Rattacher</button>
        </div>
      </form>
    `);
    document.getElementById("modal-annuler").addEventListener("click", () => ouvrirModalIntegrationReaffectation(reaffectationId));
    document.getElementById("form-rattacher").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const familleId = fd.get("famille_id");
      try {
        await addDoc(collection(db, "family_members"), {
          association_id: state.associationId,
          family_id: familleId,
          nom: r.nom,
          date_naissance: r.date_naissance || "",
          sexe: r.sexe || "",
          situation_matrimoniale: r.situation_matrimoniale || "celibataire",
          statut: "actif",
          origine_reaffectation_id: reaffectationId,
          date_creation: serverTimestamp(),
        });
        await updateDoc(doc(db, "reaffectations", reaffectationId), {
          statut: "traite",
          date_traitement: serverTimestamp(),
          integre_comme: "dependant",
          integre_dans_famille_id: familleId,
        });
        notifier(`${r.nom} a été intégré(e) à la famille.`, "succes");
        fermerModal();
      } catch (err) {
        notifier("Erreur : " + err.message, "erreur");
      }
    });
  });

  document.getElementById("btn-devient-chef").addEventListener("click", async () => {
    try {
      const nouvelleFamilleRef = await addDoc(collection(db, "families"), {
        association_id: state.associationId,
        nom_famille: r.nom,
        chef_membre_id: null,
        chef_nom_prevu: r.nom,
        en_attente_chef: true,
        statut: "active",
        date_creation: serverTimestamp(),
      });

      const code = genererCode("MBR");
      await setDoc(doc(db, "codes_parrainage", code), {
        type: "membre",
        association_id: state.associationId,
        coordination_id: state.currentUser.coordination_id,
        proprietaire_id: state.currentUser.uid,
        family_id_cible: nouvelleFamilleRef.id,
        actif: true,
        date_creation: serverTimestamp(),
      });

      await updateDoc(doc(db, "reaffectations", reaffectationId), {
        statut: "traite",
        date_traitement: serverTimestamp(),
        integre_comme: "chef",
        integre_dans_famille_id: nouvelleFamilleRef.id,
      });

      notifier("Nouvelle famille créée.", "succes");
      ouvrirModal(`
        <h2>Code généré pour ${r.nom}</h2>
        <p class="subtitle-sm">Transmettez ce code à cette personne pour qu'elle crée son propre compte sur l'application Membre.</p>
        <div class="code-display">${code}</div>
        <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-code" style="flex:1;">Terminé</button></div>
      `);
      document.getElementById("modal-fermer-code").addEventListener("click", fermerModal);
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

// ---------- CAS SOCIAUX ----------

function personnesReconnues() {
  const liste = [];
  state.familles.forEach((f) => {
    const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
    if (chef) {
      liste.push({
        type: "chef",
        id: chef.uid,
        nom: chef.nom,
        familleId: f.id,
        familleNom: f.nom_famille || chef.nom,
      });
    }
    dependantsActifs(f.id).forEach((fm) => {
      liste.push({
        type: "dependant",
        id: fm.id,
        nom: fm.nom,
        familleId: f.id,
        familleNom: f.nom_famille || (chef ? chef.nom : "?"),
      });
    });
  });
  return liste;
}

const libellesCategorie = {
  maladie: "Maladie",
  deces: "Décès",
  urgence: "Urgence",
  education: "Scolarité / Éducation",
  autre: "Autre",
};
const libellesStatutCas = {
  signale: "Signalé",
  evalue: "En évaluation",
  propose: "Proposition en attente",
  valide: "Validé",
  rejete: "Rejeté",
  execute: "Exécuté",
  cloture: "Clôturé",
};

function renderCasSociaux() {
  const container = document.getElementById("liste-cas-sociaux");
  if (state.socialCases.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun cas social enregistré pour l'instant.</p>`;
    return;
  }
  const tri = [...state.socialCases].sort((a, b) => (b.date_creation?.toMillis?.() || 0) - (a.date_creation?.toMillis?.() || 0));
  container.innerHTML = tri.map((c) => `
    <div class="entity-card" data-cas-id="${c.id}" style="cursor:pointer;">
      <div class="entity-card-top">
        <div>
          <p class="entity-nom">${c.beneficiaire_nom} <span style="font-weight:400; color:#777;">(${c.reference || ""})</span></p>
          <p class="entity-sub">${libellesCategorie[c.categorie] || c.categorie} · ${c.famille_nom || ""} · ${formatDate(c.date_creation)}</p>
        </div>
        <span class="badge ${["cloture", "rejete"].includes(c.statut) ? "badge-actif" : "badge-erreur"}">${libellesStatutCas[c.statut] || c.statut}</span>
      </div>
    </div>
  `).join("");

  container.querySelectorAll("[data-cas-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalCasSocial(card.dataset.casId));
  });
}

document.getElementById("btn-nouveau-cas-social").addEventListener("click", () => {
  if (permission("cas_sociaux") === "aucun" || sousRoleActuel() !== "secretaire_general") {
    notifier("Seul le Secrétaire général peut signaler un nouveau cas social.", "erreur");
    return;
  }
  const personnes = personnesReconnues();
  if (personnes.length === 0) {
    notifier("Aucune personne enregistrée dans une famille. L'application ne reconnaît que les personnes déjà déclarées.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Signaler un cas social</h2>
    <p class="subtitle-sm">Seules les personnes déjà enregistrées peuvent être sélectionnées.</p>
    <form id="form-nouveau-cas">
      <div class="field-row">
        <label>Personne concernée</label>
        <select name="personne" required>
          <option value="">— Choisir —</option>
          ${personnes.map((p) => `<option value="${p.type}|${p.id}|${p.familleId}">${p.nom} (${p.familleNom})</option>`).join("")}
        </select>
      </div>
      <div class="field-row">
        <label>Catégorie</label>
        <select name="categorie" required>
          <option value="maladie">Maladie</option>
          <option value="deces">Décès</option>
          <option value="urgence">Urgence</option>
          <option value="education">Scolarité / Éducation</option>
          <option value="autre">Autre</option>
        </select>
      </div>
      <div class="field-row">
        <label>Urgence</label>
        <select name="urgence" required>
          <option value="faible">Faible</option>
          <option value="moyenne" selected>Moyenne</option>
          <option value="haute">Haute</option>
        </select>
      </div>
      <div class="field-row">
        <label>Description</label>
        <textarea name="description" rows="3" required></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Signaler</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-nouveau-cas").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const [type, id, familleId] = fd.get("personne").split("|");
    const p = personnes.find((x) => x.type === type && x.id === id);
    try {
      await addDoc(collection(db, "social_cases"), {
        association_id: state.associationId,
        beneficiaire_type: type,
        beneficiaire_id: id,
        beneficiaire_nom: p ? p.nom : "",
        famille_id: familleId,
        famille_nom: p ? p.familleNom : "",
        categorie: fd.get("categorie"),
        urgence: fd.get("urgence"),
        description: fd.get("description").trim(),
        reference: genererReferenceCas(),
        statut: "signale",
        participations: {},
        enregistre_par: state.currentUser.uid,
        date_creation: serverTimestamp(),
      });
      notifier("Cas social signalé.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
});

function ouvrirModalCasSocial(casId) {
  const c = state.socialCases.find((x) => x.id === casId);
  if (!c) return;

  const tauxRetard = calculerTauxRetardFamille(c.famille_id);
  const eligibilite = evaluerEligibiliteAssistance(c.famille_id, state.socialCases, tauxRetard);
  const peutAgir = casSocialActionAutorisee(c.statut);

  let blocSuivant = "";

  if (!peutAgir && !["cloture", "rejete"].includes(c.statut)) {
    const roleAttendu = c.statut === "propose" ? "au Président" : "au Secrétaire général";
    blocSuivant = `
      <p class="subtitle-sm">Ce dossier attend une action ${roleAttendu}.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
      </div>
    `;
  } else if (c.statut === "signale") {
    blocSuivant = `
      <form id="form-etape">
        <p class="subtitle-sm">Passer à l'évaluation.</p>
        <div class="field-row">
          <label>Responsable de l'instruction</label>
          <input type="text" name="responsable_nom" value="${state.currentUser.nom}" required />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Démarrer l'évaluation</button>
        </div>
      </form>
    `;
  } else if (c.statut === "evalue") {
    blocSuivant = `
      <form id="form-etape">
        <p class="subtitle-sm">Proposer une aide.</p>
        <div class="field-row">
          <label>Montant proposé (GNF)</label>
          <input type="number" name="montant_propose" min="0" required />
        </div>
        <div class="field-row">
          <label>Nature de l'aide</label>
          <input type="text" name="nature_propose" placeholder="Ex : Aide financière, don en nature..." required />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Soumettre la proposition</button>
        </div>
      </form>
    `;
  } else if (c.statut === "propose") {
    const blocageActif = !eligibilite.eligible;
    blocSuivant = `
      ${blocageActif ? `
        <div class="field-row" style="background:#fdecea; border-radius:10px; padding:10px;">
          <p style="color:#c0392b; font-weight:600; margin:0;">Famille non éligible selon la règle du bureau</p>
          <p class="subtitle-sm" style="margin:4px 0 0;">${eligibilite.motif}</p>
        </div>
      ` : ""}
      <form id="form-etape">
        <p class="subtitle-sm">Montant proposé : <strong>${formatMontant(c.montant_propose)}</strong> (${c.nature_propose || ""})</p>
        ${blocageActif ? `
          <div class="field-row">
            <label style="display:flex; align-items:flex-start; gap:8px; font-weight:400;">
              <input type="checkbox" name="derogation" style="margin-top:3px;" required />
              <span>Je confirme, sous ma responsabilité, une dérogation malgré l'inéligibilité constatée.</span>
            </label>
          </div>
        ` : ""}
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost-sm" id="btn-rejeter" style="flex:1;">Rejeter</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Valider</button>
        </div>
      </form>
    `;
  } else if (c.statut === "valide") {
    blocSuivant = `
      <form id="form-etape">
        <p class="subtitle-sm">Enregistrer l'exécution de l'aide.</p>
        <div class="field-row">
          <label>Montant réellement accordé (GNF)</label>
          <input type="number" name="montant_accorde" min="0" value="${c.montant_propose || 0}" required />
        </div>
        <div class="field-row">
          <label>Référence du justificatif</label>
          <input type="text" name="justificatif_note" placeholder="Ex : Reçu n°, témoin, etc." />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Marquer comme exécuté</button>
        </div>
      </form>
    `;
  } else if (c.statut === "execute") {
    blocSuivant = `
      <form id="form-etape">
        <p class="subtitle-sm">Clôturer le dossier.</p>
        <div class="field-row">
          <label>Résultat / motif de clôture</label>
          <textarea name="resultat_cloture" rows="2" required></textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
          <button type="submit" class="btn btn-primary" style="flex:1;">Clôturer</button>
        </div>
      </form>
    `;
  } else {
    blocSuivant = `
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
      </div>
    `;
  }

  ouvrirModal(`
    <h2>${c.beneficiaire_nom} <span style="font-weight:400; color:#777; font-size:14px;">(${c.reference || ""})</span></h2>
    <p class="subtitle-sm">${libellesCategorie[c.categorie] || c.categorie} · Urgence ${c.urgence} · Famille : ${c.famille_nom || "—"}</p>
    <p style="margin:10px 0;">${c.description || ""}</p>
    <div class="field-row"><label>Statut actuel</label><p>${libellesStatutCas[c.statut] || c.statut}</p></div>
    <div class="field-row"><label>Taux de retard de paiement (12 mois, famille)</label><p>${tauxRetard} %</p></div>
    <div class="field-row"><label>Taux d'absence aux cas sociaux (12 mois, famille)</label><p>${eligibilite.tauxAbsence !== null ? eligibilite.tauxAbsence + " %" : "Pas de données"}</p></div>
    <hr style="margin:14px 0; border:none; border-top:1px solid #eee;" />
    ${blocSuivant}
    ${peutAgir ? `
    <hr style="margin:14px 0; border:none; border-top:1px solid #eee;" />
    <button type="button" class="btn btn-ghost-sm" id="btn-gerer-presences" style="width:100%;">Enregistrer les présences des familles à ce cas</button>
    ` : ""}
  `);

  document.getElementById("modal-annuler")?.addEventListener("click", fermerModal);
  document.getElementById("btn-gerer-presences")?.addEventListener("click", () => ouvrirModalPresencesCas(casId));

  if (!peutAgir) return;

  const btnRejeter = document.getElementById("btn-rejeter");
  if (btnRejeter) {
    btnRejeter.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "social_cases", casId), {
          statut: "rejete",
          date_rejet: serverTimestamp(),
        });
        notifier("Cas rejeté.", "succes");
        fermerModal();
      } catch (err) {
        notifier("Erreur : " + err.message, "erreur");
      }
    });
  }

  const form = document.getElementById("form-etape");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        if (c.statut === "signale") {
          await updateDoc(doc(db, "social_cases", casId), {
            statut: "evalue",
            responsable_id: state.currentUser.uid,
            responsable_nom: fd.get("responsable_nom"),
            date_evaluation: serverTimestamp(),
          });
        } else if (c.statut === "evalue") {
          await updateDoc(doc(db, "social_cases", casId), {
            statut: "propose",
            montant_propose: Number(fd.get("montant_propose")),
            nature_propose: fd.get("nature_propose"),
            date_proposition: serverTimestamp(),
          });
        } else if (c.statut === "propose") {
          await updateDoc(doc(db, "social_cases", casId), {
            statut: "valide",
            derogation_eligibilite: !eligibilite.eligible,
            valide_par: state.currentUser.uid,
            date_validation: serverTimestamp(),
          });
        } else if (c.statut === "valide") {
          await updateDoc(doc(db, "social_cases", casId), {
            statut: "execute",
            montant_accorde: Number(fd.get("montant_accorde")),
            justificatif_note: fd.get("justificatif_note") || "",
            date_execution: serverTimestamp(),
          });
        } else if (c.statut === "execute") {
          await updateDoc(doc(db, "social_cases", casId), {
            statut: "cloture",
            resultat_cloture: fd.get("resultat_cloture"),
            date_cloture: serverTimestamp(),
          });
        }
        notifier("Dossier mis à jour.", "succes");
        fermerModal();
      } catch (err) {
        notifier("Erreur : " + err.message, "erreur");
      }
    });
  }
}

function ouvrirModalPresencesCas(casId) {
  const c = state.socialCases.find((x) => x.id === casId);
  if (!c) return;
  const participations = c.participations || {};

  const lignes = state.familles.map((f) => {
    const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
    const valeur = participations[f.id] || "";
    return `
      <div class="field-row" data-famille-id="${f.id}">
        <label>${f.nom_famille || (chef ? chef.nom : "Famille")}</label>
        <select data-select-presence>
          <option value="" ${valeur === "" ? "selected" : ""}>Non concerné / pas de donnée</option>
          <option value="present" ${valeur === "present" ? "selected" : ""}>Présent</option>
          <option value="absent" ${valeur === "absent" ? "selected" : ""}>Absent</option>
        </select>
      </div>
    `;
  }).join("");

  ouvrirModal(`
    <h2>Présences — ${c.reference || ""}</h2>
    <p class="subtitle-sm">Indiquez, pour chaque famille attendue, si elle était présente ou absente à ce cas social.</p>
    <form id="form-presences">
      ${lignes || '<p class="empty-state">Aucune famille enregistrée.</p>'}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", () => ouvrirModalCasSocial(casId));
  document.getElementById("form-presences").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nouvellesParticipations = {};
    document.querySelectorAll("[data-famille-id]").forEach((ligne) => {
      const val = ligne.querySelector("[data-select-presence]").value;
      if (val) nouvellesParticipations[ligne.dataset.familleId] = val;
    });
    try {
      await updateDoc(doc(db, "social_cases", casId), { participations: nouvellesParticipations });
      notifier("Présences enregistrées.", "succes");
      ouvrirModalCasSocial(casId);
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

// ---------- UTILISATEURS / BUREAU (accès Président / Secrétaire / Gestionnaire) ----------

function renderUtilisateursBureau() {
  const container = document.getElementById("liste-utilisateurs-bureau");
  if (!container) return;
  if (state.bureauUtilisateurs.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun accès enregistré.</p>`;
    return;
  }
  const tri = [...state.bureauUtilisateurs].sort((a, b) => ((a.sous_role || "president") === "president" ? -1 : 1));
  container.innerHTML = tri.map((u) => {
    const sousRole = u.sous_role || "president";
    const estMoi = u.uid === state.currentUser.uid;
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${u.nom}${estMoi ? " (vous)" : ""}</p>
            <p class="entity-sub">${u.telephone || ""} · ${u.email || ""}</p>
          </div>
          <span class="badge ${u.statut === "actif" ? "badge-actif" : "badge-erreur"}">${libellesSousRole[sousRole] || sousRole}</span>
        </div>
        ${sousRole !== "president" && !estMoi ? `
          <div class="modal-actions" style="margin-top:8px;">
            <button type="button" class="btn btn-ghost-sm btn-toggle-statut-bureau" data-id="${u.uid}" data-statut="${u.statut}" style="flex:1;">
              ${u.statut === "actif" ? "Désactiver cet accès" : "Réactiver cet accès"}
            </button>
          </div>
        ` : ""}
      </div>
    `;
  }).join("");

  container.querySelectorAll(".btn-toggle-statut-bureau").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (permission("utilisateurs") !== "gerer") return;
      const nouveauStatut = btn.dataset.statut === "actif" ? "inactif" : "actif";
      try {
        await updateDoc(doc(db, "users", btn.dataset.id), { statut: nouveauStatut });
        notifier(nouveauStatut === "actif" ? "Accès réactivé." : "Accès désactivé.", "succes");
      } catch (err) {
        notifier("Erreur : " + err.message, "erreur");
      }
    });
  });
}

document.getElementById("btn-nouvel-acces-bureau")?.addEventListener("click", () => {
  if (permission("utilisateurs") !== "gerer") return;
  ouvrirModal(`
    <h2>Nouvel accès Bureau</h2>
    <p class="subtitle-sm">Créez un accès pour le Secrétaire général ou le Gestionnaire financier de votre association.</p>
    <form id="form-nouvel-acces-bureau">
      <div class="field-row">
        <label>Nom complet</label>
        <input type="text" name="nom" required />
      </div>
      <div class="field-row">
        <label>Téléphone</label>
        <input type="tel" name="telephone" required />
      </div>
      <div class="field-row">
        <label>E-mail</label>
        <input type="email" name="email" required />
      </div>
      <div class="field-row">
        <label>Mot de passe provisoire (6 caractères min)</label>
        <input type="password" name="password" minlength="6" required />
      </div>
      <div class="field-row">
        <label>Accès</label>
        <select name="sous_role" required>
          <option value="secretaire_general">Secrétaire général</option>
          <option value="gestionnaire_financier">Gestionnaire financier</option>
        </select>
      </div>
      <p id="accesError" style="color:#c0392b; font-size:13px;"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Créer l'accès</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-nouvel-acces-bureau").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("accesError");
    errEl.textContent = "";
    const fd = new FormData(e.target);
    const nom = fd.get("nom").trim();
    const telephone = fd.get("telephone").trim();
    const email = fd.get("email").trim();
    const password = fd.get("password");
    const sousRoleChoisi = fd.get("sous_role");

    try {
      const uid = await creerCompteSecondaire(email, password);
      await setDoc(doc(db, "users", uid), {
        role: "bureau",
        sous_role: sousRoleChoisi,
        nom, telephone, email,
        association_id: state.associationId,
        coordination_id: state.currentUser.coordination_id,
        statut: "actif",
        date_creation: serverTimestamp(),
      });
      notifier("Accès créé avec succès.", "succes");
      fermerModal();
    } catch (err) {
      errEl.textContent = "Erreur : " + err.message;
    }
  });
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

function ouvrirModal(html) {
  document.getElementById("modal-content").innerHTML = html;
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.remove("hidden");
  overlay.style.display = "flex";
}
function fermerModal() {
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.add("hidden");
  overlay.style.display = "none";
  document.getElementById("modal-content").innerHTML = "";
}
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") fermerModal();
});

demarrer();
