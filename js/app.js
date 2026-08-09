import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
  creerCompteSecondaire, changerMotDePasse,
} from "./firebase-config.js";

import { genererCode, formatDate, formatMontant, notifier } from "./utils.js";

const state = {
  currentUser: null,
  associationId: null,
  association: null,
  membres: [],
  cotisations: [],
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

    // On crée d'abord le compte (authentification) avant toute écriture Firestore,
    // pour respecter les règles de sécurité qui exigent un utilisateur connecté.
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
  state.unsubscribers.push(unsubMembres, unsubCotisations);
}

function render() {
  renderApercu();
  renderMembres();
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
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom}</p>
            <p class="entity-sub">${m.telephone || ""} · ${m.residence || ""}</p>
          </div>
          <span class="badge badge-actif">${formatMontant(totalCotise)}</span>
        </div>
      </div>
    `;
  }).join("");
}
document.getElementById("recherche-membres").addEventListener("input", renderMembres);

function renderCotisations() {
  const container = document.getElementById("liste-cotisations");
  if (state.cotisations.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune cotisation enregistrée pour l'instant.</p>`;
    return;
  }
  const tri = [...state.cotisations].sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
  container.innerHTML = tri.slice(0, 50).map((c) => {
    const membre = state.membres.find((m) => m.uid === c.membre_id);
    return `
      <div class="entity-card">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${membre ? membre.nom : c.membre_nom || "Membre"}</p>
            <p class="entity-sub">${c.type === "occasionnelle" ? "Cotisation occasionnelle" : "Cotisation fixe"} · ${formatDate(c.date)}</p>
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
    notifier("Aucun membre actif pour enregistrer une cotisation.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Enregistrer une cotisation</h2>
    <form id="form-cotisation">
      <div class="field-row">
        <label>Membre</label>
        <select name="membre_id" required>
          ${membresActifs.map((m) => `<option value="${m.uid}">${m.nom}</option>`).join("")}
        </select>
      </div>
      <div class="field-row">
        <label>Type</label>
        <select name="type" required>
          <option value="fixe">Cotisation fixe (mensuelle)</option>
          <option value="occasionnelle">Cotisation occasionnelle</option>
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
        type: fd.get("type"),
        montant: Number(fd.get("montant")),
        enregistre_par: state.currentUser.uid,
        date: serverTimestamp(),
      });
      notifier("Cotisation enregistrée.", "succes");
      fermerModal();
    } catch (err) {
      notifier("Erreur : " + err.message, "erreur");
    }
  });
});

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
