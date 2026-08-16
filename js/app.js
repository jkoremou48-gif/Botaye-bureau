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
  familyMembers: [],
  reglesActives: null,
  unsubscribers: [],
};
let creationEnCours = false;

const screens = ["screen-loading", "screen-login", "screen-inscription", "screen-dashboard"];
function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
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
  const unsubFamilyMembers = onSnapshot(
    query(collection(db, "family_members"), where("association_id", "==", state.associationId)),
    (snap) => {
      state.familyMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  state.unsubscribers.push(unsubMembres, unsubCotisations, unsubFamilles, unsubFamilyMembers);
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

  const famillesAyantPayeCeMois = new Set(
    state.cotisations
      .filter((c) => {
        if (!c.date || !c.date.toDate) return false;
        const d = c.date.toDate();
        return d.getMonth() === moisActuel && d.getFullYear() === anneeActuelle;
      })
      .map((c) => c.famille_id)
  );
  document.getElementById("stat-membres-a-jour").textContent = famillesAyantPayeCeMois.size;
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
            <button type="button" class="btn btn-ghost-sm btn-retirer-dependant" data-id="${fm.id}">Retirer</button>
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
  `);

  document.getElementById("modal-annuler").addEventListener("click", fermerModal);

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
  return Math.round((1 - moisPayesSur12 / 12) * 100); // % de retard estimé
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
