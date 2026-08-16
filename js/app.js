import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
  creerCompteSecondaire, changerMotDePasse,
} from "./firebase-config.js";

import { genererCode, formatDate, formatMontant, notifier } from "./utils.js";
import { calculerAge, calculerQuotaMembre, obtenirReglesActives } from "./bareme.js";

const state = {
  currentUser: null,
  associationId: null,
  association: null,
  membres: [],
  cotisations: [],
  familles: [],
  reglesActives: null,
  unsubscribers: [],
};
let creationEnCours = false;

const screens = ["screen-loading", "screen-login", "screen-inscription", "screen-dashboard"];
function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
}

function telephoneVersEmailTechnique(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return `${chiffres}@membre.botaye.local`;
}

function demarrer() {
  showScreen("screen-loading");
  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    if (user) {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      if (userSnap.exists() && userSnap.data().role === "bureau") {
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
      nom, telephone, email,
      association_id: assocRef.id,
      coordination_id: coordinationId,
      statut: "actif",
      date_creation: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), userData);
    await updateDoc(codeRef, { actif: false, utilise_par: cred.user.uid });

    notifier("Association créée avec succès.", "succes");
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
  document.getElementById("db-bureau-nom").textContent = state.currentUser.nom;

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
  state.unsubscribers.push(unsubMembres, unsubCotisations, unsubFamilles);
}

function render() {
  renderApercu();
  renderMembres();
  renderFamilles();
  renderCotisations();
}

function renderApercu() {
  const total = state.cotisations.reduce((s, c) => s + Number(c.montant || 0), 0);
  document.getElementById("stat-solde-caisse").textContent = formatMontant(total);
  document.getElementById("stat-nb-membres").textContent = state.membres.filter((m) => m.statut === "actif").length;

  const maintenant = new Date();
  const moisActuel = maintenant.getMonth();
  const anneeActuelle = maintenant.getFullYear();
  const totalMois = state.cotisations
    .filter((c) => {
      if (!c.date || !c.date.toDate) return false;
      const d = c.date.toDate();
      return d.getMonth() === moisActuel && d.getFullYear() === anneeActuelle;
    })
    .reduce((s, c) => s + Number(c.montant || 0), 0);
  document.getElementById("stat-cotisations-mois").textContent = formatMontant(totalMois);

  const membresAyantCotiseCeMois = new Set(
    state.cotisations
      .filter((c) => {
        if (!c.date || !c.date.toDate) return false;
        const d = c.date.toDate();
        return d.getMonth() === moisActuel && d.getFullYear() === anneeActuelle;
      })
      .map((c) => c.membre_id)
  );
  document.getElementById("stat-membres-a-jour").textContent = membresAyantCotiseCeMois.size;
}

// ---------- MEMBRES ----------

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
    const totalCotise = state.cotisations.filter((c) => c.membre_id === m.uid).reduce((s, c) => s + Number(c.montant || 0), 0);
    const famille = state.familles.find((f) => f.id === m.family_id);
    const age = calculerAge(m.date_naissance);
    const profilIncomplet = age === null || !m.sexe;
    return `
      <div class="entity-card" data-membre-id="${m.uid}" style="cursor:pointer;">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom}</p>
            <p class="entity-sub">${m.telephone || ""} · ${m.residence || ""}</p>
            <p class="entity-sub" style="margin-top:2px;">
              ${age !== null ? age + " ans" : '<span style="color:#c0392b;">Âge non renseigné</span>'}
              ${famille ? " · Famille : " + (famille.nom_famille || "Sans nom") : ""}
              ${profilIncomplet ? ' · <span style="color:#c0392b;">Profil incomplet</span>' : ""}
            </p>
          </div>
          <span class="badge badge-actif">${formatMontant(totalCotise)}</span>
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
  const famille = state.familles.find((f) => f.id === m.family_id);

  ouvrirModal(`
    <h2>${m.nom}</h2>
    <p class="subtitle-sm">Complétez le profil pour permettre le calcul automatique du quota (barème BÖTAYE).</p>
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
          <option value="marie" ${m.situation_matrimoniale === "marie" ? "selected" : ""}>Marié(e), conjoint(e) au foyer</option>
        </select>
      </div>
      <p class="subtitle-sm">${famille ? "Famille actuelle : " + (famille.nom_famille || "Sans nom") + " (gestion depuis l'onglet Familles)" : "Aucune famille rattachée pour l'instant."}</p>
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

function renderFamilles() {
  const container = document.getElementById("liste-familles");
  if (state.familles.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune famille enregistrée pour l'instant.</p>`;
    return;
  }
  container.innerHTML = state.familles.map((f) => {
    const chef = state.membres.find((m) => m.uid === f.chef_membre_id);
    const membresFamille = state.membres.filter((m) => m.family_id === f.id);
    let total = 0;
    membresFamille.forEach((m) => {
      const q = calculerQuotaMembre(m, state.reglesActives);
      if (q.applique) total += q.montant;
    });
    return `
      <div class="entity-card" data-famille-id="${f.id}" style="cursor:pointer;">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${f.nom_famille || "Famille " + (chef ? chef.nom : "?")}</p>
            <p class="entity-sub">Chef : ${chef ? chef.nom : "—"} · ${membresFamille.length} membre(s)</p>
          </div>
          <span class="badge badge-actif">${formatMontant(total)}</span>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-famille-id]").forEach((card) => {
    card.addEventListener("click", () => ouvrirModalFamille(card.dataset.familleId));
  });
}

document.getElementById("btn-nouvelle-famille").addEventListener("click", () => {
  if (state.membres.length === 0) {
    notifier("Aucun membre disponible pour désigner un chef de famille.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Créer une famille</h2>
    <form id="form-nouvelle-famille">
      <div class="field-row">
        <label>Nom de la famille (optionnel)</label>
        <input type="text" name="nom_famille" placeholder="Ex : Famille Camara" />
      </div>
      <div class="field-row">
        <label>Chef de famille</label>
        <select name="chef_membre_id" required>
          ${state.membres.map((m) => `<option value="${m.uid}">${m.nom}${m.family_id ? " (déjà dans une famille)" : ""}</option>`).join("")}
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
  const membresFamille = state.membres.filter((m) => m.family_id === f.id);
  const membresDisponibles = state.membres.filter((m) => m.family_id !== f.id);

  let total = 0;
  const lignesMembres = membresFamille.map((m) => {
    const q = calculerQuotaMembre(m, state.reglesActives);
    if (q.applique) total += q.montant;
    const estChef = m.uid === f.chef_membre_id;
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom} ${estChef ? "(chef)" : ""}</p>
            <p class="entity-sub">${q.formule}</p>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="badge badge-actif">${q.applique ? formatMontant(q.montant) : "—"}</span>
            ${!estChef ? `<button type="button" class="btn btn-ghost-sm btn-retirer-membre" data-uid="${m.uid}">Retirer</button>` : ""}
          </div>
        </div>
      </div>
    `;
  }).join("");

  ouvrirModal(`
    <h2>${f.nom_famille || "Famille " + (chef ? chef.nom : "?")}</h2>
    <p class="subtitle-sm">Chef de famille : ${chef ? chef.nom : "—"}</p>
    <div style="margin:14px 0;">${lignesMembres || '<p class="empty-state">Aucun membre pour l’instant.</p>'}</div>
    <p style="font-weight:600;">Total quota famille : ${formatMontant(total)}</p>
    <hr style="margin:16px 0; border:none; border-top:1px solid #eee;" />
    <form id="form-ajouter-membre-famille">
      <div class="field-row">
        <label>Ajouter un membre à cette famille</label>
        <select name="membre_id" required>
          <option value="">— Choisir —</option>
          ${membresDisponibles.map((m) => `<option value="${m.uid}">${m.nom}${m.family_id ? " (sera retiré de son autre famille)" : ""}</option>`).join("")}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Fermer</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Ajouter</button>
      </div>
    </form>
  `);

  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.querySelectorAll(".btn-retirer-membre").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "users", btn.dataset.uid), { family_id: null });
        notifier("Membre retiré de la famille.", "succes");
        ouvrirModalFamille(familleId);
      } catch (err) {
        notifier("Erreur : " + err.message, "erreur");
      }
    });
  });
  document.getElementById("form-ajouter-membre-famille").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const membreId = fd.get("membre_id");
    if (!membreId) return;
    try {
      await updateDoc(doc(db, "users", membreId), { family_id: familleId });
      notifier("Membre ajouté à la famille.", "succes");
      ouvrirModalFamille(familleId);
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
    fixe: "Cotisation fixe",
    occasionnelle: "Cotisation occasionnelle",
    libre: "Paiement libre",
  };
  const tri = [...state.cotisations].sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
  container.innerHTML = tri.slice(0, 50).map((c) => {
    const membre = state.membres.find((m) => m.uid === c.membre_id);
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${membre ? membre.nom : c.membre_nom || "Membre"}</p>
            <p class="entity-sub">${libellesType[c.type] || c.type} · ${formatDate(c.date)}</p>
          </div>
          <span class="badge badge-actif">${formatMontant(c.montant)}</span>
        </div>
      </div>
    `;
  }).join("");
}

// Paiement libre (correction, cas particulier, cotisation hors barème)
document.getElementById("btn-nouvelle-cotisation").addEventListener("click", () => {
  const membresActifs = state.membres.filter((m) => m.statut === "actif");
  if (membresActifs.length === 0) {
    notifier("Aucun membre actif pour enregistrer une cotisation.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Paiement libre</h2>
    <p class="subtitle-sm">À utiliser pour une correction ou un cas particulier hors barème. Pour la cotisation normale, utilisez « Encaisser le quota d'une famille ».</p>
    <form id="form-cotisation">
      <div class="field-row">
        <label>Membre</label>
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
    try {
      await addDoc(collection(db, "cotisations"), {
        association_id: state.associationId,
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

// Encaissement du quota calculé pour une famille entière (flux principal du guide)
document.getElementById("btn-encaisser-quota-famille").addEventListener("click", () => {
  if (state.familles.length === 0) {
    notifier("Aucune famille enregistrée. Créez d'abord une famille.", "erreur");
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
  const membresFamille = state.membres.filter((m) => m.family_id === f.id);

  if (membresFamille.length === 0) {
    notifier("Cette famille n'a aucun membre rattaché.", "erreur");
    return;
  }

  const periodeParDefaut = new Date().toISOString().slice(0, 7); // YYYY-MM

  const lignes = membresFamille.map((m) => {
    const q = calculerQuotaMembre(m, state.reglesActives);
    if (q.applique) {
      return `
        <div class="field-row" data-ligne data-membre-id="${m.uid}" data-type="quota" data-montant="${q.montant}">
          <label>${m.nom} — ${q.formule}</label>
          <p style="font-weight:600;">${formatMontant(q.montant)}</p>
        </div>
      `;
    }
    // Profil incomplet ou contribution volontaire → saisie manuelle possible
    return `
      <div class="field-row" data-ligne data-membre-id="${m.uid}" data-type="volontaire">
        <label>${m.nom} — ${q.formule}</label>
        <input type="number" min="0" placeholder="Montant (laisser vide si aucun paiement)" data-input-volontaire />
      </div>
    `;
  }).join("");

  ouvrirModal(`
    <h2>${f.nom_famille || "Famille"}</h2>
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
      const membreId = ligne.dataset.membreId;
      const membre = state.membres.find((m) => m.uid === membreId);
      const type = ligne.dataset.type;
      if (type === "quota") {
        operations.push({
          membre_id: membreId,
          membre_nom: membre ? membre.nom : "",
          type: "quota",
          montant: Number(ligne.dataset.montant),
        });
      } else {
        const input = ligne.querySelector("[data-input-volontaire]");
        const val = Number(input.value);
        if (val > 0) {
          operations.push({
            membre_id: membreId,
            membre_nom: membre ? membre.nom : "",
            type: "volontaire",
            montant: val,
          });
        }
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
          membre_id: op.membre_id,
          membre_nom: op.membre_nom,
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
      <p class="subtitle-sm">Transmettez ce code au nouveau membre. Il devra le saisir lors de son inscription sur l'application Membre.</p>
      <div class="code-display">${code}</div>
      <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-code" style="flex:1;">Terminé</button></div>
    `);
    document.getElementById("modal-fermer-code").addEventListener("click", fermerModal);
  } catch (err) {
    notifier("Erreur : " + err.message, "erreur");
  }
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
