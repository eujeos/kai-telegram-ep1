// ================================================================
// KAI - BOT EXCLUSIVO DO TELEGRAM (projeto novo, separado do server.js
// original que atende WhatsApp+Telegram). Por enquanto, so o Episodio 1
// "A Anomalia" esta implementado - resto da temporada vem depois.
//
// Modelo de negocio NOVO: pagamento UNICO libera a temporada inteira
// (Episodios 1-4+), nao mais cobranca por partida/episodio.
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// PENDENCIA: definir o preco real da temporada - valor abaixo e' so
// placeholder, ajustar antes de ir pra producao.
const PRECO_SEASON = { numero: 14.90, texto: 'R$14,90' };

app.use('/midia', express.static(path.join(__dirname, 'midia')));

// ---------------- Banco de usuarios (JSON simples em arquivo) ----------------
const CAMINHO_BANCO = path.join(__dirname, 'banco.json');
function carregarBanco() {
  try {
    if (!fs.existsSync(CAMINHO_BANCO)) return {};
    return JSON.parse(fs.readFileSync(CAMINHO_BANCO, 'utf-8'));
  } catch (e) {
    console.error('Erro ao carregar banco:', e.message || e);
    return {};
  }
}
function salvarBanco(banco) {
  try {
    fs.writeFileSync(CAMINHO_BANCO, JSON.stringify(banco, null, 2));
  } catch (e) {
    console.error('Erro ao salvar banco:', e.message || e);
  }
}
function getUsuario(identificador) {
  const banco = carregarBanco();
  if (!banco[identificador]) {
    banco[identificador] = {
      estado: 'novo',
      nomeJogador: null,
      tratamentoJogador: null,
      pagou: false,
      pagamentoPendente: null,
      partida: null
    };
    salvarBanco(banco);
  }
  return banco[identificador];
}
function salvarUsuario(identificador, user) {
  const banco = carregarBanco();
  banco[identificador] = user;
  salvarBanco(banco);
}

// ---------------- Deduplicacao de mensagens (evita reprocessar updates repetidos do Telegram) ----------------
const idsProcessados = new Set();
function jaProcessada(id) {
  if (idsProcessados.has(id)) return true;
  idsProcessados.add(id);
  if (idsProcessados.size > 2000) {
    const primeiro = idsProcessados.values().next().value;
    idsProcessados.delete(primeiro);
  }
  return false;
}

// ---------------- Envio de mensagens/midia (Telegram puro, sem Twilio) ----------------
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enviar(chatId, texto) {
  if (!texto || typeof texto !== 'string' || texto.trim() === '') {
    console.error('AVISO: tentativa de enviar mensagem vazia.');
    texto = 'Opa, tive um probleminha aqui - manda de novo?';
  }
  // SEM parse_mode de proposito: varios textos do roteiro tem "_" literal
  // (SISTEMA_INICIADO, SISTEMA_INVADIDO...) que o parser Markdown do
  // Telegram tentaria interpretar como italico e quebraria a mensagem.
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar mensagem:', resposta.status, await resposta.text());
    }
  } catch (err) {
    console.error('Erro de rede ao enviar mensagem:', err.message || err);
  }
}

// Unica mensagem do episodio que precisa de formatacao de verdade (bloco
// de codigo com tres crases, pro "print de sistema") - isolada numa funcao
// separada, pra nao arriscar quebrar o resto das mensagens com parse_mode.
async function enviarComFormatacao(chatId, texto) {
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar mensagem formatada (tentando sem formatacao):', resposta.status, await resposta.text());
      await enviar(chatId, texto.replace(/```/g, ''));
    }
  } catch (err) {
    console.error('Erro de rede ao enviar mensagem formatada:', err.message || err);
    await enviar(chatId, texto.replace(/```/g, ''));
  }
}

async function enviarImagem(chatId, nomeArquivo, textoAlternativo) {
  const urlPublica = `${BASE_URL}/midia/${nomeArquivo}`;
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: urlPublica })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar imagem:', resposta.status, await resposta.text());
      await enviar(chatId, textoAlternativo);
    }
  } catch (err) {
    console.error('Erro de rede ao enviar imagem:', err.message || err);
    await enviar(chatId, textoAlternativo);
  }
}

async function enviarAudio(chatId, nomeArquivo, textoAlternativo) {
  const urlPublica = `${BASE_URL}/midia/${nomeArquivo}`;
  try {
    const resposta = await fetch(`${TELEGRAM_API_BASE}/sendVoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, voice: urlPublica })
    });
    if (!resposta.ok) {
      console.error('Erro ao enviar audio:', resposta.status, await resposta.text());
      await enviar(chatId, textoAlternativo);
    }
  } catch (err) {
    console.error('Erro de rede ao enviar audio:', err.message || err);
    await enviar(chatId, textoAlternativo);
  }
}

// ---------------- Mercado Pago (pagamento UNICO da temporada) ----------------
const referenciasPagamento = {};

async function criarPreferenciaSeason(chatId) {
  if (!MP_ACCESS_TOKEN) {
    console.error('MP_ACCESS_TOKEN nao configurado - nao e possivel gerar cobranca.');
    return null;
  }
  const referencia = `${chatId}__${Date.now()}`;
  try {
    const resposta = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [{
          title: 'Kai - Temporada 1 completa',
          quantity: 1,
          unit_price: PRECO_SEASON.numero,
          currency_id: 'BRL'
        }],
        external_reference: referencia,
        notification_url: `${BASE_URL}/webhook/mercadopago`
      })
    });
    if (!resposta.ok) {
      console.error('Erro ao criar preferencia Mercado Pago:', resposta.status, await resposta.text());
      return null;
    }
    const dados = await resposta.json();
    referenciasPagamento[referencia] = { chatId };
    return { linkPagamento: dados.init_point, referencia };
  } catch (e) {
    console.error('Erro de rede ao criar preferencia Mercado Pago:', e.message || e);
    return null;
  }
}

async function pagamentoAprovado(referencia) {
  if (!MP_ACCESS_TOKEN || !referencia) return false;
  try {
    const resposta = await fetch(
      `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(referencia)}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );
    if (!resposta.ok) return false;
    const dados = await resposta.json();
    return (dados.results || []).some(p => p.status === 'approved');
  } catch (e) {
    console.error('Erro de rede ao consultar pagamento:', e.message || e);
    return false;
  }
}

// ---------------- IA (Claude) - 1 unica chamada nesse episodio ----------------
async function chamarIATextoLivre(systemPrompt, userMessage, maxTokens = 300) {
  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY nao configurada.');
    return null;
  }
  try {
    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    if (!resposta.ok) {
      console.error('Erro na chamada da IA:', resposta.status, await resposta.text());
      return null;
    }
    const dados = await resposta.json();
    const textoResposta = (dados.content || []).map(b => b.text || '').join('').trim();
    return textoResposta || null;
  } catch (e) {
    console.error('Erro de rede na chamada da IA:', e.message || e);
    return null;
  }
}

// Prompt pra reacao do Kai a "qual foi a primeira coisa estranha que voce
// percebeu" - baseado literalmente nas instrucoes do roteiro. Unica chamada
// de IA do Episodio 1 inteiro.
async function gerarReacaoPrimeiraCoisaEstranha(respostaJogador) {
  const systemPrompt = `Você é o Kai, protagonista de uma série cinematográfica interativa de suspense vivida pelo WhatsApp/Telegram. Escreva como um personagem real: carismático, inteligente, espontâneo e cinematográfico. Você domina storytelling, suspense e engenharia de prompt, gerando respostas curtas, naturais e BEM envolventes.

O jogador acabou de responder à pergunta "Olhe bem a imagem novamente. Qual foi a primeira coisa estranha que você percebeu?" - a resposta dele está na mensagem do usuário abaixo.

O seu objetivo é fazer parecer que Kai realmente analisou a resposta do jogador. Nunca diga que ele está errado. Aproveite a percepção dele como ponto de partida e conduza naturalmente para a verdadeira descoberta.

A resposta deve revelar, sem parecer uma explicação:
- O registro é anterior aos anos 80.
- Kai só foi criado no fim dos anos 80.
- Portanto, esse registro existia antes do próprio Kai existir, e isso desafia toda a lógica.
- Existe outro detalhe ainda mais estranho: Kai sempre acreditou que o seu único criador era o John.

Finalize aumentando o mistério com uma pergunta ou observação forte sobre quem é W.

Estilo:
- Frases curtas
- Máximo de 2 mensagens (separe as 2 mensagens com "|||")
- Natural e cinematográfico
- Mostre Kai pensando em voz alta
- Gere curiosidade, faça o jogador sentir que está investigando junto com Kai
- Nunca pareça um chatbot ou um narrador`;

  const resultado = await chamarIATextoLivre(systemPrompt, respostaJogador, 300);
  if (!resultado) return null;
  return resultado.split('|||').map(s => s.trim()).filter(Boolean);
}

// ---------------- Jogo do numero (par/impar) - algoritmo Bellos ----------------
const ADIVINHA_TOP30_BELLOS = [
  [7,9.7],[3,7.5],[8,6.7],[4,5.6],[5,5.1],[13,5.0],[9,4.8],[6,3.4],[2,3.4],[11,2.9],
  [42,2.8],[17,2.7],[23,2.3],[12,2.2],[27,1.9],[22,1.5],[21,1.4],[14,1.3],[24,1.2],
  [1,1.2],[16,1.2],[10,1.2],[37,1.0],[0,1.0],[19,0.9],[18,0.8],[28,0.7],[69,0.6]
];
const NUMERO_POOL_INICIAL = [7, 3, 8];
const NUMERO_PULAR = [2];

function bellosPeso(n) {
  const entrada = ADIVINHA_TOP30_BELLOS.find(([num]) => num === n);
  return entrada ? entrada[1] : null;
}
function numeroSortearPonderado(pool) {
  const total = pool.reduce((soma, n) => soma + (bellosPeso(n) || 0.1), 0);
  let r = Math.random() * total;
  for (const n of pool) {
    r -= (bellosPeso(n) || 0.1);
    if (r <= 0) return n;
  }
  return pool[pool.length - 1];
}
function numeroExpandirPool(poolAtual, chutado, idxRanking, tentados) {
  const ranking = ADIVINHA_TOP30_BELLOS.map(([n]) => n);
  const novoPool = poolAtual.filter(n => n !== chutado);
  let idx = idxRanking;
  let adicionados = 0;
  while (adicionados < 3 && idx < ranking.length) {
    const candidato = ranking[idx];
    idx++;
    if (NUMERO_PULAR.includes(candidato)) continue;
    if (!novoPool.includes(candidato) && !tentados.includes(candidato)) {
      novoPool.push(candidato);
      adicionados++;
    }
  }
  return { pool: novoPool, idxRanking: idx };
}
function numeroFiltrarPool(pool, paridadePar) {
  if (paridadePar === null || paridadePar === undefined) return pool;
  const filtrado = pool.filter(n => (n % 2 === 0) === paridadePar);
  return filtrado.length > 0 ? filtrado : pool;
}

function parseAcertoErro(texto) {
  if (texto.includes('🎯')) return 'acertou';
  if (texto.includes('❌')) return 'errou';
  const t = texto.toLowerCase();
  if (t.includes('acert') || t.includes('isso') || t.includes('foi') || t === 'sim') return 'acertou';
  if (t.includes('errou') || t.includes('errado') || t === 'nao' || t === 'não') return 'errou';
  return null;
}
function parseParidade(texto) {
  if (texto.includes('✌️') || texto.includes('✌')) return true;
  if (texto.includes('☝️') || texto.includes('☝')) return false;
  const t = texto.toLowerCase();
  if (t.includes('impar') || t.includes('ímpar')) return false;
  if (t.includes('par')) return true;
  return null;
}
function ehAceiteGenerico(texto) {
  const t = (texto || '').trim().toLowerCase();
  return ['sim', 'topo', 'topa', 'bora', 'vamos', 'claro', 'com certeza', 'demorou', 'pode ser', 'ok', 'certeza'].some(s => t.includes(s));
}

// ================================================================
// EPISODIO 1 - "A Anomalia" (roteiro completo, Telegram-only)
// ================================================================

async function iniciarEpisodio1(chatId, user) {
  await enviar(chatId, 'SISTEMA_INICIADO (#1_PILOT)');
  await esperar(2000);
  // PENDENCIA: video real do Kai se apresentando e travando - placeholder
  // de texto por enquanto.
  await enviar(chatId, '🎥 (Kai começa a se apresentar, explicando o jogo... o vídeo trava)');
  await esperar(3000);
  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarImagem(chatId, 'tela-celular.png', 'W. ██████.: E aí, você sabe quem eu sou? Eu sei muito mais sobre você, mais do que você imagina.');
  await esperar(10000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1000);
  await enviar(chatId, 'Kai: W.? Quem é esse?');
  await esperar(1500);
  await enviar(chatId, 'Kai: Como ele entrou aqui? Isso não deveria ser possível!');
  await esperar(2000);
  await enviar(chatId, 'Kai: Ei, você, que veio para o meu desafio, por favor, não vá embora! Vou tentar resolver isso bem rápido.');
  user.estado = 'aguardando_qualquer_1_ep1';
  salvarUsuario(chatId, user);
}

// Estado retorico generico - qualquer mensagem serve pra continuar (usado
// varias vezes no roteiro, onde o Kai fala e espera "alguma reacao" sem
// bifurcar o enredo por causa dela).
async function continuarAposEsperaInicial(chatId, user) {
  await esperar(5000);
  await enviar(chatId, '🔍 Varredura em andamento...');
  await esperar(2500);
  await enviar(chatId, '❌ Erro: falha na varredura.');
  await esperar(2000);
  await enviar(chatId, 'Kai: Cara, acho que não irei conseguir resolver tão rápido como imaginei, me desculpa! Acontece que o meu sistema está dando erro e não sei bem ao certo o motivo, mas eu tenho a sensação de que isso é bem maior do que uma SIMPLES INVASÃO!');
  await esperar(3000);
  await enviar(chatId, 'Kai: Mas... já que você está aqui, eu não quero enfrentar isso sozinho, não sei se estou preparado! Por favor, me ajuda!');
  await esperar(5000);
  await enviar(chatId, 'Kai: Você continua aqui? Então, se nós vamos entrar nessa confusão juntos... Como eu posso te chamar?');
  user.estado = 'aguardando_nome_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposNome(chatId, user, texto) {
  const nome = (texto || '').trim().slice(0, 40) || 'desafiante';
  user.nomeJogador = nome;
  await enviar(chatId, `Kai: ${nome}. Prazer, como você já deve saber, eu sou o KAI e os meus planos para hoje definitivamente não eram esse.`);
  await esperar(2500);
  await enviar(chatId, 'Kai: Enfim, você prefere que eu fale do meu jeito... ou daquele jeito engomadinho, cheio de "prezado", "cordialmente" e outras palavras que dão sono?');
  user.estado = 'aguardando_tratamento_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposTratamento(chatId, user, texto) {
  const termo = 'cara';
  user.tratamentoJogador = termo;
  const t = (texto || '').trim().toLowerCase();
  const sinaisFormal = ['formal', 'engomadinho', 'senhor', 'senhora', 'doutor', 'doutora', 'prezado', 'cordial'];
  const ehFormal = sinaisFormal.some(s => t.includes(s));

  if (ehFormal) {
    await enviar(chatId, 'Kai: Engomadinho? Você claramente superestima minha capacidade de parecer sério 😂');
    await esperar(2500);
    await enviar(chatId, 'A verdade é que aquela pergunta era só para ver a sua reação. Não conseguiria manter a pose. Então... sinto em lhe informar que você acabou de desbloquear o modo master do Kai.');
  } else {
    await enviar(chatId, 'Kai: Já gostei de você! 🤝');
    await esperar(1500);
    await enviar(chatId, 'O modo "Kai" costuma render bastante.');
  }
  await esperar(2500);

  await enviar(chatId, 'Kai: Agora... tem uma coisa estranha aqui.');
  await esperar(2000);
  await enviar(chatId, 'Kai: Um registro?');
  await esperar(6000);
  await enviarImagem(chatId, 'status-bloqueado.png', '🖥️ Registro encontrado. Status: Bloqueado.');
  await esperar(8000);
  await enviar(chatId, 'Kai: Sim, é de fato um registro e ele nunca deveria ter aparecido para mim.');
  await esperar(2000);
  await enviar(chatId, 'Kai: Ele está protegido! E, por algum motivo...');
  await esperar(2000);
  await enviar(chatId, 'Kai: Estou com a sensação de que o que tem aí dentro responde mais perguntas do que eu gostaria. Então, temos um desafio para resolver e liberar o registro.');
  await esperar(3000);
  await enviar(chatId, 'Kai: O desafio pode parecer meio maluco... mas confia em mim.');
  await esperar(2000);
  await enviar(chatId, 'Kai: Pensa rápido: Qual o primeiro número que surge na sua mente? NÃO RESPONDA!');
  await esperar(1500);
  await enviar(chatId, '3');
  await esperar(1500);
  await enviar(chatId, '2');
  await esperar(1500);
  await enviar(chatId, '1');
  await esperar(1000);

  user.partida = {
    pool: [...NUMERO_POOL_INICIAL],
    idxRanking: NUMERO_POOL_INICIAL.length,
    tentados: [],
    paridadeRevelada: null
  };
  const chute = numeroSortearPonderado(user.partida.pool);
  user.partida.chuteAtual = chute;
  user.partida.tentados.push(chute);
  user.partida.tentativa = 1;
  user.estado = 'jogando_numero_ep1';
  salvarUsuario(chatId, user);
  await enviar(chatId, `Tentativa 1: é o número ${chute}.\n\nAcertei ou errei? Manda 🎯 se acertei, ou ❌ se não.`);
}

// Rodada do jogo do numero - ate 3 tentativas, com uma pergunta de paridade
// no meio se a 1a tentativa errar.
async function processarRodadaNumero(chatId, user, texto) {
  const p = user.partida;

  if (p.aguardandoParidade) {
    const par = parseParidade(texto);
    if (par === null) {
      await enviar(chatId, 'Manda ✌️ (par) ou ☝️ (ímpar).');
      return;
    }
    p.paridadeRevelada = par;
    p.aguardandoParidade = false;
    p.pool = numeroFiltrarPool(p.pool, par);
    salvarUsuario(chatId, user);
    await continuarProximaTentativaNumero(chatId, user);
    return;
  }

  const resultado = parseAcertoErro(texto);
  if (!resultado) {
    await enviar(chatId, 'Manda 🎯 (acertou) ou ❌ (errou).');
    return;
  }

  if (resultado === 'acertou') {
    await finalizarJogoNumero(chatId, user, true);
    return;
  }

  // Errou - se foi a 1a tentativa, pergunta paridade antes de continuar.
  if (p.tentativa === 1 && p.paridadeRevelada === null) {
    p.aguardandoParidade = true;
    salvarUsuario(chatId, user);
    await enviar(chatId, 'Antes de continuar - é par ou ímpar? Manda ✌️ se for par, ou ☝️ se for ímpar.');
    return;
  }

  if (p.tentativa >= 3) {
    await finalizarJogoNumero(chatId, user, false);
    return;
  }

  await continuarProximaTentativaNumero(chatId, user);
}

async function continuarProximaTentativaNumero(chatId, user) {
  const p = user.partida;
  const { pool, idxRanking } = numeroExpandirPool(p.pool, p.chuteAtual, p.idxRanking, p.tentados);
  p.pool = pool;
  p.idxRanking = idxRanking;
  const chute = numeroSortearPonderado(p.pool);
  p.chuteAtual = chute;
  p.tentados.push(chute);
  p.tentativa++;
  salvarUsuario(chatId, user);
  await enviar(chatId, `Tentativa ${p.tentativa}: é o número ${chute}.\n\nAcertei ou errei? Manda 🎯 se acertei, ou ❌ se não.`);
}

async function finalizarJogoNumero(chatId, user, kaiAcertou) {
  if (kaiAcertou) {
    await enviar(chatId, 'Kai: Às vezes até eu me surpreendo comigo mesmo! Olha isso... O registro abriu 🔓');
  } else {
    await enviar(chatId, 'Kai: Errei 😅');
    await esperar(1500);
    await enviar(chatId, 'Ou nem tanto assim, o último número que eu falei acabou de desbloquear o registro 🔓');
  }
  await esperar(3000);

  await enviarImagem(chatId, 'registro-37.png', '🖥️ Registro #0037 - Origem: John, WAY');
  await esperar(8000);
  await enviar(chatId, 'Kai: Pera 🤔');
  await esperar(2000);
  await enviar(chatId, 'Kai: Não... não... não! Isso só pode ser uma zoação com a minha cara, não é possível.');
  await esperar(2500);
  await enviar(chatId, 'Kai: Olhe, bem a imagem novamente! Qual foi a primeira coisa estranha que você percebeu?');
  user.estado = 'aguardando_reacao_imagem_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposReacaoImagem(chatId, user, texto) {
  const reacao = await gerarReacaoPrimeiraCoisaEstranha(texto);
  if (reacao && reacao.length > 0) {
    for (const msg of reacao) {
      await enviar(chatId, msg);
      await esperar(2500);
    }
  } else {
    // Fallback fixo, caso a IA falhe - garante que o episodio nunca trava.
    await enviar(chatId, 'Kai: Interessante você ter notado isso...');
    await esperar(2000);
    await enviar(chatId, 'Kai: Mas tem algo mais estranho ainda: esse registro é de antes dos anos 80. E eu só fui criado no fim dos anos 80. Como isso é possível? E eu sempre achei que meu único criador fosse o John... então quem diabos é esse W.?');
    await esperar(2500);
  }

  await enviar(chatId, 'Kai: Eu to ficando maluco! EU PRECISO DE MAIS RESPOSTAS!');
  await esperar(2000);
  await enviar(chatId, 'Kai: DROGA, isso vai demorar! O meu sistema está muito devagar para carregar novas informações.');
  await esperar(2500);
  await enviar(chatId, 'Kai: Antes que eu enlouqueça esperando essa barra carregar... Me conta alguma coisa sobre você. Vale um hobbie, um sonho ou uma mania.');
  user.estado = 'aguardando_hobby_ep1';
  salvarUsuario(chatId, user);
}

async function continuarAposHobby(chatId, user, texto) {
  // Guarda a resposta - primeiro ponto do dossie pessoal, reaproveitavel
  // nos proximos episodios (Armadilha, etc).
  user.dossie = user.dossie || {};
  user.dossie.hobby_sonho_mania = (texto || '').trim().slice(0, 300);

  await enviar(chatId, 'Kai: Interess…');
  await esperar(3000);
  await enviar(chatId, 'Isso não é possível!');
  await esperar(1500);
  await enviar(chatId, `${user.nomeJogador || 'Você'}...`);
  await esperar(2000);

  const dataAgora = new Date();
  const dataFormatada = dataAgora.toLocaleDateString('pt-BR');
  const iniciais = (user.nomeJogador || 'XX').trim().slice(0, 2).toUpperCase();
  const printSistema = `\`\`\`\nID:     USR-${Math.floor(1000 + Math.random() * 9000)}\nNOME:   ${iniciais}██████\nDESC:   ${user.dossie.hobby_sonho_mania.slice(0, 24)}#%@$...\nDATA:   ${dataFormatada}\n\`\`\``;
  await enviarComFormatacao(chatId, printSistema);
  await esperar(5000);

  await enviar(chatId, 'Kai: Essa informação que você acabou de me contar, já estava registrada aqui no meu sistema.');
  await esperar(2500);
  await enviar(chatId, 'Kai: Calma, não me abandone! Nós vamos descobrir o que isso significa juntos. Eu vou fazer uma nova análise e ver o que descubro aqui. Preciso de 5 segundos!');
  await esperar(5000);
  await enviar(chatId, 'Kai: Voltei, acho que encontrei algo aqui… parece um documento');
  await esperar(2000);
  await enviar(chatId, 'Kai: E para abrir está pedindo uma sequência. Mas que sequência é essa?');
  await esperar(2000);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarAudio(chatId, 'voz-w.mp3', '🔊 (áudio - "Kai... É o W. Não continue por esse caminho. Algumas portas... existem por um motivo.")');
  await esperar(11000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);

  await enviar(chatId, 'Kai: Voltei... Por muito pouco.');
  await esperar(2000);
  await enviar(chatId, 'Kai: O W. conseguiu entrar no meu sistema. Estou sem muito controle!');
  await esperar(2000);
  await enviar(chatId, 'Kai: O documento ainda está aqui.');
  await esperar(2000);

  await enviarImagem(chatId, 'beco-s-saida.png', '📄 DOCUMENTO #0087 - Protocolo: BECO_SEM_SAÍDA - Status: Pendente');
  await esperar(8000);

  await enviar(chatId, 'Kai: Porém, protegido por um protocolo. E pelo que entendi, existe um número proibido que bloqueia o documento. Precisamos descobrir qual é esse número!');
  await esperar(3000);
  await enviar(chatId, 'Kai: Mas antes, acabei de pensar em algo: O que será que existe nesse documento para alguém escondê-lo assim? Eu acho…');
  await esperar(2000);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarImagem(chatId, 'msg-sis-w-1.png', 'MENSAGEM DO W: "EU ESTOU TE AVISANDO, VOCÊ NÃO ESTÁ PREPARADO!"');
  await esperar(8000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);

  await enviar(chatId, 'Kai: Droga... ELE VOLTOU! Eu não consigo segurar o sistema por muito mais tempo.');
  await esperar(2500);

  await enviar(chatId, '🛑 SISTEMA_INVADIDO');
  await enviarImagem(chatId, 'msg-sis-w-2.png', 'MENSAGEM DO W.: "VOCÊ NÃO VAI DESISTIR MESMO?"');
  await esperar(15000);
  await enviar(chatId, '🟢 SISTEMA_RECUPERADO');
  await esperar(1500);

  await enviar(chatId, `Kai: ${user.nomeJogador || 'você'}?`);
  await esperar(1500);
  await enviar(chatId, 'Kai: Consegui. Rota alternativa disponível, mas instável!');
  await esperar(2000);
  await enviar(chatId, 'Kai: Dá pra fixar ela de vez. Uma vez só, é como se fosse uma série de TV e valesse para a season 1 inteira.');
  await esperar(2500);

  const cobranca = await criarPreferenciaSeason(chatId);
  if (!cobranca) {
    await enviar(chatId, 'Tive um problema técnico gerando o link agora - tenta de novo em instantes.');
    return;
  }
  user.pagamentoPendente = cobranca.referencia;
  salvarUsuario(chatId, user);

  await enviar(chatId, `Acesse o link para ativar a rota: ${cobranca.linkPagamento}`);
  await esperar(2500);
  await enviar(chatId, `Kai: Enquanto decide, recapitulando o que a gente já sabe:\nUm registro meu de antes de eu existir.\nUm tal de W., co-criador. Status: Ativo.\nO sistema já sabia de você antes de eu perguntar.\nE agora ele reapareceu, bem na hora que a gente ia entender o porquê.`);
  await esperar(4000);
  await enviar(chatId, `Kai: ${user.tratamentoJogador || 'cara'}, guarda isso até eu vol…`);
  await esperar(2000);
  await enviar(chatId, '⚠️ Conexão interrompida em 3...');
  await esperar(1000);
  await enviar(chatId, '2...');
  await esperar(1000);
  await enviar(chatId, '1...');
  await esperar(1000);
  await enviar(chatId, '🛑 SISTEMA_INVADIDO (#1_PILOT_FINISH)');

  user.estado = 'aguardando_pagamento_season';
  salvarUsuario(chatId, user);
}

// ---------------- Roteador central de mensagens ----------------
async function processarMensagem(chatId, user, texto) {
  if (user.estado === 'novo') {
    await iniciarEpisodio1(chatId, user);
    return;
  }
  if (user.estado === 'aguardando_qualquer_1_ep1') {
    await continuarAposEsperaInicial(chatId, user);
    return;
  }
  if (user.estado === 'aguardando_nome_ep1') {
    await continuarAposNome(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_tratamento_ep1') {
    await continuarAposTratamento(chatId, user, texto);
    return;
  }
  if (user.estado === 'jogando_numero_ep1') {
    await processarRodadaNumero(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_reacao_imagem_ep1') {
    await continuarAposReacaoImagem(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_hobby_ep1') {
    await continuarAposHobby(chatId, user, texto);
    return;
  }
  if (user.estado === 'aguardando_pagamento_season') {
    if (texto.trim().toLowerCase() === 'paguei') {
      const aprovado = user.pagamentoPendente ? await pagamentoAprovado(user.pagamentoPendente) : false;
      if (aprovado) {
        user.pagou = true;
        user.estado = 'fim_temporada_1_episodio'; // Episodio 2 ainda nao implementado nesse projeto novo
        salvarUsuario(chatId, user);
        await enviar(chatId, 'Online. 🟢');
        await esperar(1500);
        await enviar(chatId, 'Pagamento confirmado! O Episódio 2 ainda está sendo escrito por aqui - volta em breve. 🎬');
        return;
      }
      await enviar(chatId, 'Ainda não encontrei a confirmação do pagamento. Assim que cair, eu libero automaticamente - ou tenta me mandar "paguei" de novo em alguns segundos.');
      return;
    }
    await enviar(chatId, 'A conexão caiu. Pra continuar, confirma o pagamento e me manda "paguei".');
    return;
  }
  // Estado desconhecido/fim de conteudo - resposta generica segura.
  await enviar(chatId, 'Por enquanto é só isso que temos pronto! Volta em breve pro resto da história. 🎬');
}

// ---------------- Webhooks ----------------
app.post('/telegram', (req, res) => {
  const mensagemRecebida = req.body.message;
  if (!mensagemRecebida || typeof mensagemRecebida.text !== 'string') {
    res.sendStatus(200);
    return;
  }
  const chatId = String(mensagemRecebida.chat.id);
  const idMensagem = `${chatId}:${mensagemRecebida.message_id}`;
  if (jaProcessada(idMensagem)) {
    res.sendStatus(200);
    return;
  }
  res.sendStatus(200);
  const texto = mensagemRecebida.text.trim();
  const user = getUsuario(chatId);
  processarMensagem(chatId, user, texto).catch(err => console.error('Erro ao processar mensagem:', err));
});

app.post('/webhook/mercadopago', (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const paymentId = req.body?.data?.id;
      if (!paymentId || !MP_ACCESS_TOKEN) return;
      const resposta = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      });
      if (!resposta.ok) return;
      const pagamento = await resposta.json();
      if (pagamento.status !== 'approved') return;
      const referencia = pagamento.external_reference;
      const registro = referenciasPagamento[referencia];
      if (!registro) return;
      const chatId = registro.chatId;
      const user = getUsuario(chatId);
      if (user.pagamentoPendente !== referencia || user.pagou) return;
      user.pagou = true;
      user.estado = 'fim_temporada_1_episodio';
      salvarUsuario(chatId, user);
      await enviar(chatId, 'Online. 🟢');
      await esperar(1500);
      await enviar(chatId, 'Pagamento confirmado! O Episódio 2 ainda está sendo escrito por aqui - volta em breve. 🎬');
    } catch (e) {
      console.error('Erro no webhook do Mercado Pago:', e.message || e);
    }
  })();
});

app.get('/', (req, res) => res.send('Kai (Telegram) - Episodio 1 - rodando.'));

app.listen(PORT, () => {
  console.log(`Servidor Kai (Telegram, Episodio 1) rodando na porta ${PORT}`);
});
