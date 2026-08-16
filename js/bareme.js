import { db, collection, query, where, getDocs } from "./firebase-config.js";

// Barème par défaut — utilisé tant qu'aucune règle versionnée n'existe
// pour l'association. Ces valeurs doivent rester identiques dans les 3 apps.
const REGLES_PAR_DEFAUT = {
  taux_homme: 500,
  taux_femme: 250,
  prime_homme_marie: 10000,
  prime_femme_mariee: 5000,
  age_limite: 60,
};

function calculerAge(dateNaissance) {
  if (!dateNaissance) return null;
  const naissance = new Date(dateNaissance);
  if (isNaN(naissance.getTime())) return null;
  const auj = new Date();
  let age = auj.getFullYear() - naissance.getFullYear();
  const m = auj.getMonth() - naissance.getMonth();
  if (m < 0 || (m === 0 && auj.getDate() < naissance.getDate())) age--;
  return age;
}

// Récupère la règle de cotisation active la plus récente pour une association.
// Repli automatique sur le barème par défaut si aucune règle n'est encore paramétrée.
async function obtenirReglesActives(associationId) {
  try {
    const q = query(
      collection(db, "contribution_rules"),
      where("association_id", "==", associationId),
      where("actif", "==", true)
    );
    const snap = await getDocs(q);
    if (snap.empty) return { ...REGLES_PAR_DEFAUT, id: null };

    let plusRecente = null;
    snap.docs.forEach((d) => {
      const data = d.data();
      const millisActuel = data.date_effet?.toMillis?.() || 0;
      const millisRetenu = plusRecente?.date_effet?.toMillis?.() || -1;
      if (millisActuel >= millisRetenu) plusRecente = { id: d.id, ...data };
    });
    return plusRecente || { ...REGLES_PAR_DEFAUT, id: null };
  } catch (err) {
    return { ...REGLES_PAR_DEFAUT, id: null };
  }
}

// Calcule le quota d'un membre selon le barème (section 8 du guide BÖTAYE).
// Retourne { montant, formule, applique, volontaire }.
// - applique=false + volontaire=true  → personne > âge limite (contribution volontaire)
// - applique=false + volontaire=false → profil incomplet (date de naissance ou sexe manquant)
function calculerQuotaMembre(membre, regles) {
  const r = regles || REGLES_PAR_DEFAUT;
  const age = calculerAge(membre.date_naissance);

  if (age === null) {
    return { montant: null, formule: "Profil incomplet (date de naissance manquante)", applique: false, volontaire: false, age: null };
  }
  if (age > r.age_limite) {
    return { montant: null, formule: `Contribution volontaire (> ${r.age_limite} ans)`, applique: false, volontaire: true, age };
  }
  if (membre.sexe !== "M" && membre.sexe !== "F") {
    return { montant: null, formule: "Profil incomplet (sexe manquant)", applique: false, volontaire: false, age };
  }

  const estMarie = membre.situation_matrimoniale === "marie";

  if (membre.sexe === "M") {
    const montant = r.taux_homme * age + (estMarie ? r.prime_homme_marie : 0);
    const formule = estMarie ? `${r.taux_homme} × ${age} + ${r.prime_homme_marie}` : `${r.taux_homme} × ${age}`;
    return { montant, formule, applique: true, volontaire: false, age };
  }

  const montant = r.taux_femme * age + (estMarie ? r.prime_femme_mariee : 0);
  const formule = estMarie ? `${r.taux_femme} × ${age} + ${r.prime_femme_mariee}` : `${r.taux_femme} × ${age}`;
  return { montant, formule, applique: true, volontaire: false, age };
}

export { calculerAge, calculerQuotaMembre, obtenirReglesActives, REGLES_PAR_DEFAUT };
