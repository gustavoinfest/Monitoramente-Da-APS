import { useEffect, useState, useMemo, ChangeEvent } from 'react';
import { collection, onSnapshot, query, doc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { Activity, Users, Stethoscope, FileText, Loader2, AlertCircle, Upload, X, FileUp } from 'lucide-react';
import Papa from 'papaparse';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Types
interface Diagnostico {
  codigo: string;
  descricao: string;
  quantidade: number;
}

interface Profissional {
  cbo: string;
  quantidade: number;
}

interface ProducaoConsolidada {
  id: string;
  unidade: string;
  municipio: string;
  competencia?: string;
  total_atendimentos?: number;
  diagnosticos?: {
    cid?: Diagnostico[];
    ciap?: Diagnostico[];
  } | (Diagnostico & { tipo: string })[];
  profissionais?: Profissional[];
  data_processamento?: any;
  equipe_ine?: string;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

export default function App() {
  const [data, setData] = useState<ProducaoConsolidada[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Upload Modal State
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadUnidade, setUploadUnidade] = useState('');
  const [uploadCompetencia, setUploadCompetencia] = useState('');
  const [uploadEquipeIne, setUploadEquipeIne] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);

  // Filters
  const [selectedUnidade, setSelectedUnidade] = useState<string>('Todas');
  const [selectedCompetencia, setSelectedCompetencia] = useState<string>('Todas');

  useEffect(() => {
    setLoadingData(true);
    setError(null);

    const q = query(collection(db, 'producao_consolidada'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs: ProducaoConsolidada[] = [];
      snapshot.forEach((doc) => {
        docs.push({ id: doc.id, ...doc.data() } as ProducaoConsolidada);
      });
      setData(docs);
      setLoadingData(false);
    }, (err) => {
      console.error("Error fetching data:", err);
      setError("Erro ao carregar dados. Verifique suas permissões.");
      setLoadingData(false);
    });

    return () => unsubscribe();
  }, []);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      setIsUploadModalOpen(true);
      
      // Reset fields
      setUploadUnidade('');
      setUploadCompetencia('');
      setUploadEquipeIne('');
      setIsExtracting(true);

      try {
        const ext = file.name.split('.').pop()?.toLowerCase();
        let text = '';

        if (ext === 'pdf') {
          try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // Add timeout to prevent hanging if worker fails
            const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
            const pdf = await Promise.race([
              loadingTask.promise,
              new Promise<any>((_, reject) => setTimeout(() => reject(new Error("Timeout carregando PDF")), 10000))
            ]);

            if (pdf.numPages > 0) {
              const page = await pdf.getPage(1);
              const textContent = await page.getTextContent();
              
              // Sort items top-to-bottom, left-to-right to ensure logical reading order
              const items = textContent.items.map((item: any) => ({
                str: item.str,
                x: item.transform[4],
                y: item.transform[5]
              }));
              
              items.sort((a, b) => {
                if (Math.abs(b.y - a.y) > 5) return b.y - a.y; // Top to bottom
                return a.x - b.x; // Left to right
              });
              
              text = items.map(item => item.str).join(' ').replace(/\s+/g, ' ');
            }
          } catch (pdfErr) {
            console.error("Erro ao ler PDF no preview:", pdfErr);
            // Ignore error here, let user fill manually
          }
        } else if (ext === 'csv' || ext === 'json') {
          text = await file.text();
          text = text.replace(/\s+/g, ' ');
        }

        console.log("Texto extraído para análise:", text.substring(0, 800));

        // Extract Unidade
        const unidadeMatch = text.match(/(?:Unidade de Sa[úu]de|Unidade|Estabelecimento)\s*:?\s*(.+?)(?=\s+(?:Equipe|INE|Per[íi]odo|Compet[êe]ncia|Profissional|CBO|Impresso|P[áa]gina|Relat[óo]rio|CNES|Munic[íi]pio|$))/i);
        if (unidadeMatch && unidadeMatch[1]) {
          setUploadUnidade(unidadeMatch[1].replace(/^:\s*/, '').trim());
        }

        // Extract Equipe / INE
        const equipeMatch = text.match(/Equipe\s*:?\s*(.+?)(?=\s+(?:INE|Per[íi]odo|Compet[êe]ncia|Profissional|CBO|Impresso|P[áa]gina|Relat[óo]rio|CNES|Munic[íi]pio|Unidade|$))/i);
        const ineMatch = text.match(/INE\s*:?\s*(\d+)/i);
        
        let equipeStr = '';
        if (equipeMatch && equipeMatch[1]) equipeStr = equipeMatch[1].replace(/^:\s*/, '').trim();
        if (ineMatch && ineMatch[1]) {
          if (!equipeStr.includes(ineMatch[1])) {
            equipeStr = equipeStr ? `${equipeStr} - INE: ${ineMatch[1]}` : `INE: ${ineMatch[1]}`;
          }
        }
        if (equipeStr) setUploadEquipeIne(equipeStr);

        // Extract Competência
        const compMatch = text.match(/Compet[êe]ncia\s*:?\s*(\d{2}\/\d{4})/i);
        if (compMatch && compMatch[1]) {
          setUploadCompetencia(compMatch[1].trim());
        } else {
          const periodMatch = text.match(/Per[íi]odo\s*:?\s*\d{2}\/\d{2}\/\d{4}\s*a\s*\d{2}\/(\d{2})\/(\d{4})/i);
          if (periodMatch && periodMatch[1] && periodMatch[2]) {
            setUploadCompetencia(`${periodMatch[1]}/${periodMatch[2]}`);
          } else {
            const anyPeriod = text.match(/\d{2}\/\d{2}\/\d{4}\s*a\s*\d{2}\/(\d{2})\/(\d{4})/i);
            if (anyPeriod && anyPeriod[1] && anyPeriod[2]) {
              setUploadCompetencia(`${anyPeriod[1]}/${anyPeriod[2]}`);
            }
          }
        }
      } catch (err) {
        console.error("Error extracting metadata:", err);
      } finally {
        setIsExtracting(false);
      }
    }
    e.target.value = '';
  };

  const processFile = async () => {
    if (!uploadFile || !uploadUnidade || !uploadCompetencia) {
      alert('Preencha os campos de Unidade e Competência e selecione um arquivo.');
      return;
    }
    
    setIsUploading(true);
    
    try {
      const ext = uploadFile.name.split('.').pop()?.toLowerCase();
      let jsonData: any = null;

      if (ext === 'json') {
        const text = await uploadFile.text();
        jsonData = JSON.parse(text);
        jsonData.unidade = uploadUnidade;
        jsonData.competencia = uploadCompetencia;
      } else if (ext === 'csv') {
        const text = await uploadFile.text();
        const results = Papa.parse(text, { header: true, skipEmptyLines: true });
        
        const diagnosticos: any[] = [];
        results.data.forEach((row: any) => {
          const values = Object.values(row);
          const codigo = String(row['Código'] || row['codigo'] || row['CID'] || row['CIAP'] || values[0] || '').trim();
          const descricao = String(row['Descrição'] || row['descricao'] || values[1] || '').trim();
          const quantidade = parseInt(String(row['Quantidade'] || row['quantidade'] || values[2] || '0'));
          
          if (codigo) {
            const isCid = /^[A-Z]\d{2}/.test(codigo);
            const isCiap = /^[A-Z]\d{2,3}/.test(codigo);
            if (isCid || isCiap) {
              diagnosticos.push({
                codigo,
                descricao,
                quantidade: isNaN(quantidade) ? 0 : quantidade,
                tipo: isCid ? 'CID' : 'CIAP'
              });
            }
          }
        });
        
        jsonData = {
          unidade: uploadUnidade,
          municipio: 'Sinop',
          competencia: uploadCompetencia,
          equipe_ine: uploadEquipeIne,
          data_processamento: new Date().toISOString(),
          total_atendimentos: diagnosticos.reduce((acc, curr) => acc + curr.quantidade, 0),
          diagnosticos,
          profissionais: []
        };
        
        if (diagnosticos.length === 0) {
          throw new Error("Nenhum diagnóstico encontrado no CSV. Verifique se o arquivo é o relatório correto.");
        }
      } else if (ext === 'pdf') {
        const arrayBuffer = await uploadFile.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
        const pdf = await Promise.race([
          loadingTask.promise,
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error("Tempo limite excedido ao ler o PDF. Tente novamente ou use o formato CSV.")), 15000))
        ]);
        
        const diagnosticos: any[] = [];
        
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          
          // Group by Y coordinate (with a small tolerance of 2px)
          const rows: { [y: number]: { str: string, x: number }[] } = {};
          textContent.items.forEach((item: any) => {
            if (item.str.trim() === '') return;
            const y = Math.round(item.transform[5] / 2) * 2;
            if (!rows[y]) rows[y] = [];
            rows[y].push({ str: item.str.trim(), x: item.transform[4] });
          });
          
          // Process rows
          Object.values(rows).forEach(rowItems => {
            rowItems.sort((a, b) => a.x - b.x);
            const rowStr = rowItems.map(i => i.str).join(' ');
            
            // Look for patterns like "I10 Hipertensão essencial 110"
            const match = rowStr.match(/^([A-Z]\d{2,3})\s+(.+?)\s+(\d+)$/);
            if (match) {
              const codigo = match[1];
              const isCid = /^[A-Z]\d{2}$/.test(codigo);
              diagnosticos.push({
                codigo,
                descricao: match[2],
                quantidade: parseInt(match[3]),
                tipo: isCid ? 'CID' : 'CIAP'
              });
            } else {
              // Fallback: try to extract if it's separated differently
              const parts = rowItems.map(i => i.str);
              if (parts.length >= 3) {
                const codigo = parts[0];
                const quantidade = parseInt(parts[parts.length - 1]);
                if (/^[A-Z]\d{2,3}$/.test(codigo) && !isNaN(quantidade)) {
                  const isCid = /^[A-Z]\d{2}$/.test(codigo);
                  diagnosticos.push({
                    codigo,
                    descricao: parts.slice(1, parts.length - 1).join(' '),
                    quantidade,
                    tipo: isCid ? 'CID' : 'CIAP'
                  });
                }
              }
            }
          });
        }
        
        if (diagnosticos.length === 0) {
          throw new Error("Nenhum diagnóstico encontrado no PDF. Verifique se o arquivo é o 'Relatório de Atendimento Individual' consolidado.");
        }
        
        jsonData = {
          unidade: uploadUnidade,
          municipio: 'Sinop',
          competencia: uploadCompetencia,
          equipe_ine: uploadEquipeIne,
          data_processamento: new Date().toISOString(),
          total_atendimentos: diagnosticos.reduce((acc, curr) => acc + curr.quantidade, 0),
          diagnosticos,
          profissionais: []
        };
      } else {
        throw new Error('Formato não suportado. Use PDF, CSV ou JSON.');
      }

      if (jsonData) {
        const safeUnidade = uploadUnidade.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const safeCompetencia = uploadCompetencia.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const safeEquipe = uploadEquipeIne ? `_${uploadEquipeIne.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}` : '';
        const docId = `${safeUnidade}${safeEquipe}_${safeCompetencia}`;
        
        if (!jsonData.data_processamento) {
          jsonData.data_processamento = new Date().toISOString();
        }
        
        if (uploadEquipeIne) {
          jsonData.equipe_ine = uploadEquipeIne;
        }

        await setDoc(doc(db, 'producao_consolidada', docId), jsonData);
        alert('Dados importados com sucesso!');
        setIsUploadModalOpen(false);
        setUploadFile(null);
        setUploadUnidade('');
        setUploadCompetencia('');
        setUploadEquipeIne('');
      }
    } catch (err: any) {
      console.error("Upload error:", err);
      alert(`Erro ao importar arquivo: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Derived Data
  const unidades = useMemo(() => {
    const unique = new Set(data.map(d => d.unidade).filter(Boolean));
    return ['Todas', ...Array.from(unique)].sort();
  }, [data]);

  const competencias = useMemo(() => {
    const unique = new Set(data.map(d => d.competencia).filter(Boolean));
    return ['Todas', ...Array.from(unique)].sort().reverse();
  }, [data]);

  const filteredData = useMemo(() => {
    return data.filter(d => {
      const matchUnidade = selectedUnidade === 'Todas' || d.unidade === selectedUnidade;
      const matchCompetencia = selectedCompetencia === 'Todas' || d.competencia === selectedCompetencia;
      return matchUnidade && matchCompetencia;
    });
  }, [data, selectedUnidade, selectedCompetencia]);

  const summary = useMemo(() => {
    let totalAtendimentos = 0;
    let cidMap = new Map<string, { descricao: string, quantidade: number }>();
    let ciapMap = new Map<string, { descricao: string, quantidade: number }>();
    let profMap = new Map<string, number>();

    filteredData.forEach(d => {
      totalAtendimentos += d.total_atendimentos || 0;

      // Handle object format (from Python script)
      if (d.diagnosticos && !Array.isArray(d.diagnosticos)) {
        d.diagnosticos.cid?.forEach(c => {
          const existing = cidMap.get(c.codigo) || { descricao: c.descricao, quantidade: 0 };
          cidMap.set(c.codigo, { descricao: c.descricao, quantidade: existing.quantidade + c.quantidade });
        });

        d.diagnosticos.ciap?.forEach(c => {
          const existing = ciapMap.get(c.codigo) || { descricao: c.descricao, quantidade: 0 };
          ciapMap.set(c.codigo, { descricao: c.descricao, quantidade: existing.quantidade + c.quantidade });
        });
      } 
      // Handle array format (from JSON example)
      else if (Array.isArray(d.diagnosticos)) {
        d.diagnosticos.forEach((c: any) => {
          if (c.tipo === 'CID') {
            const existing = cidMap.get(c.codigo) || { descricao: c.descricao, quantidade: 0 };
            cidMap.set(c.codigo, { descricao: c.descricao, quantidade: existing.quantidade + c.quantidade });
          } else if (c.tipo === 'CIAP') {
            const existing = ciapMap.get(c.codigo) || { descricao: c.descricao, quantidade: 0 };
            ciapMap.set(c.codigo, { descricao: c.descricao, quantidade: existing.quantidade + c.quantidade });
          }
        });
      }

      d.profissionais?.forEach(p => {
        profMap.set(p.cbo, (profMap.get(p.cbo) || 0) + p.quantidade);
      });
    });

    const topCid = Array.from(cidMap.entries())
      .map(([codigo, val]) => ({ codigo, ...val }))
      .sort((a, b) => b.quantidade - a.quantidade)
      .slice(0, 10);

    const topCiap = Array.from(ciapMap.entries())
      .map(([codigo, val]) => ({ codigo, ...val }))
      .sort((a, b) => b.quantidade - a.quantidade)
      .slice(0, 10);

    const profissionaisChart = Array.from(profMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    return { totalAtendimentos, topCid, topCiap, profissionaisChart };
  }, [filteredData]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 text-white rounded-lg flex items-center justify-center">
              <Activity className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-tight">Monitoramento e-SUS APS</h1>
              <p className="text-xs text-slate-500">Município de Sinop</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="cursor-pointer bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border border-emerald-200 flex items-center gap-2">
              <Upload className="w-4 h-4" />
              <span className="hidden sm:inline">Importar Arquivo</span>
              <input type="file" accept=".json,.csv,.pdf" className="hidden" onChange={handleFileSelect} />
            </label>
          </div>
        </div>
      </header>

      {/* Upload Modal */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <FileUp className="w-5 h-5 text-blue-600" />
                Importar Dados
              </h2>
              <button 
                onClick={() => setIsUploadModalOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Arquivo Selecionado</label>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 truncate">
                  {uploadFile?.name}
                </div>
              </div>

              {isExtracting && (
                <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 p-3 rounded-lg border border-blue-100">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Extraindo informações do arquivo...
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Unidade de Saúde</label>
                <input 
                  type="text" 
                  value={uploadUnidade}
                  onChange={(e) => setUploadUnidade(e.target.value)}
                  placeholder="Ex: UBS Camping Club"
                  className="w-full border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2.5 border"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Equipe / INE (Opcional)</label>
                <input 
                  type="text" 
                  value={uploadEquipeIne}
                  onChange={(e) => setUploadEquipeIne(e.target.value)}
                  placeholder="Ex: EQUIPE 01 - INE: 1234567"
                  className="w-full border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2.5 border"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Competência</label>
                <input 
                  type="text" 
                  value={uploadCompetencia}
                  onChange={(e) => setUploadCompetencia(e.target.value)}
                  placeholder="Ex: 02/2026"
                  className="w-full border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2.5 border"
                />
              </div>

              <div className="pt-4">
                <button
                  onClick={processFile}
                  disabled={isUploading || !uploadUnidade || !uploadCompetencia || !uploadFile}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Processando...
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5" />
                      Confirmar Importação
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Filters */}
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-8 flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">Unidade de Saúde</label>
            <select
              value={selectedUnidade}
              onChange={(e) => setSelectedUnidade(e.target.value)}
              className="w-full border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2.5 border bg-white"
            >
              {unidades.map(u => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">Competência</label>
            <select
              value={selectedCompetencia}
              onChange={(e) => setSelectedCompetencia(e.target.value)}
              className="w-full border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2.5 border bg-white"
            >
              {competencias.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-700">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        )}

        {loadingData ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                    <Users className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Total de Atendimentos</p>
                    <p className="text-2xl font-bold text-slate-900">{summary.totalAtendimentos.toLocaleString('pt-BR')}</p>
                  </div>
                </div>
              </div>
              
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
                    <Stethoscope className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Profissionais Ativos</p>
                    <p className="text-2xl font-bold text-slate-900">{summary.profissionaisChart.length}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center">
                    <FileText className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Top CID</p>
                    <p className="text-lg font-bold text-slate-900 truncate" title={summary.topCid[0]?.descricao || '-'}>
                      {summary.topCid[0]?.codigo || '-'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center">
                    <FileText className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Top CIAP</p>
                    <p className="text-lg font-bold text-slate-900 truncate" title={summary.topCiap[0]?.descricao || '-'}>
                      {summary.topCiap[0]?.codigo || '-'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
              {/* Atendimentos por Profissional */}
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 lg:col-span-1">
                <h2 className="text-lg font-bold text-slate-900 mb-6">Atendimentos por CBO</h2>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={summary.profissionaisChart}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {summary.profissionaisChart.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(value: number) => value.toLocaleString('pt-BR')} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Top 10 CID */}
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 lg:col-span-2">
                <h2 className="text-lg font-bold text-slate-900 mb-6">Top 10 Diagnósticos (CID)</h2>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={summary.topCid} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
                      <XAxis type="number" />
                      <YAxis dataKey="codigo" type="category" width={50} />
                      <RechartsTooltip 
                        formatter={(value: number) => [value.toLocaleString('pt-BR'), 'Quantidade']}
                        labelFormatter={(label) => {
                          const item = summary.topCid.find(c => c.codigo === label);
                          return `${label} - ${item?.descricao || ''}`;
                        }}
                      />
                      <Bar dataKey="quantidade" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Tables Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* CID Table */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="p-6 border-b border-slate-200">
                  <h2 className="text-lg font-bold text-slate-900">Detalhamento CID</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-medium">Código</th>
                        <th className="px-6 py-3 font-medium">Descrição</th>
                        <th className="px-6 py-3 font-medium text-right">Qtd</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {summary.topCid.map((item) => (
                        <tr key={item.codigo} className="hover:bg-slate-50">
                          <td className="px-6 py-4 font-medium text-slate-900 whitespace-nowrap">{item.codigo}</td>
                          <td className="px-6 py-4 text-slate-600">{item.descricao}</td>
                          <td className="px-6 py-4 text-slate-900 text-right font-medium">{item.quantidade.toLocaleString('pt-BR')}</td>
                        </tr>
                      ))}
                      {summary.topCid.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-6 py-8 text-center text-slate-500">Nenhum dado encontrado</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* CIAP Table */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="p-6 border-b border-slate-200">
                  <h2 className="text-lg font-bold text-slate-900">Detalhamento CIAP</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-medium">Código</th>
                        <th className="px-6 py-3 font-medium">Descrição</th>
                        <th className="px-6 py-3 font-medium text-right">Qtd</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {summary.topCiap.map((item) => (
                        <tr key={item.codigo} className="hover:bg-slate-50">
                          <td className="px-6 py-4 font-medium text-slate-900 whitespace-nowrap">{item.codigo}</td>
                          <td className="px-6 py-4 text-slate-600">{item.descricao}</td>
                          <td className="px-6 py-4 text-slate-900 text-right font-medium">{item.quantidade.toLocaleString('pt-BR')}</td>
                        </tr>
                      ))}
                      {summary.topCiap.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-6 py-8 text-center text-slate-500">Nenhum dado encontrado</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
