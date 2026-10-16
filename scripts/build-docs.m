## build-docs.m — Genera docs/octave-docs.json con la ayuda de Octave
##
## Recorre las funciones de los paquetes control y symbolic (incluidos los
## métodos de sus clases: @tf, @ss, @lti, @sym, ...) y una lista curada de
## funciones básicas de Octave. Para cada una guarda el texto de `help`
## ya renderizado a texto plano, para que la extensión no tenga que
## invocar Octave en cada hover.
##
## Uso, parado en la raíz del repo:
##   octave --no-gui --quiet scripts/build-docs.m

1;

function entries = add_entry (entries, name, cls, pkgname, query)
  try
    [text, fmt] = get_help_text (query);
  catch
    return;
  end_try_catch
  if (isempty (strtrim (text)))
    return;
  endif
  if (strcmp (fmt, "texinfo"))
    try
      text = __makeinfo__ (text, "plain text");
    catch
      return;
    end_try_catch
  endif
  text = regexprep (text, '\r', '');
  text = regexprep (text, '\n{3,}', "\n\n");
  entries{end+1} = struct ("name", name, "class", cls, "package", pkgname,
                           "text", strtrim_right (text));
endfunction

function s = strtrim_right (s)
  s = regexprep (s, '\s+$', '');
endfunction

function entries = scan_package (entries, pkgname)
  info = pkg ("list", pkgname);
  if (isempty (info))
    warning ("paquete %s no instalado, se omite", pkgname);
    return;
  endif
  dir = info{1}.dir;
  printf ("%s (%s): %s\n", pkgname, info{1}.version, dir);

  ## Funciones de primer nivel
  files = dir_m (dir);
  for i = 1:numel (files)
    name = files{i};
    entries = add_entry (entries, name, "", pkgname, name);
  endfor

  ## Métodos de clase: carpetas @clase
  d = dir_list (dir);
  for i = 1:numel (d)
    if (d{i}(1) != "@")
      continue;
    endif
    cls = d{i}(2:end);
    methods = dir_m (fullfile (dir, d{i}));
    for j = 1:numel (methods)
      name = methods{j};
      entries = add_entry (entries, name, cls, pkgname,
                           sprintf ("@%s/%s", cls, name));
    endfor
  endfor
endfunction

function names = dir_m (d)
  f = dir (fullfile (d, "*.m"));
  names = {};
  for i = 1:numel (f)
    [~, n] = fileparts (f(i).name);
    ## Las funciones internas (__x__) no son API pública
    if (! strncmp (n, "__", 2))
      names{end+1} = n;
    endif
  endfor
endfunction

function names = dir_list (d)
  f = dir (d);
  names = {f([f.isdir]).name};
endfunction

## Funciones básicas de Octave más usadas en cursos de ingeniería
core = {
  ## Matrices y vectores
  "zeros", "ones", "eye", "rand", "randn", "linspace", "logspace", "colon", ...
  "size", "length", "numel", "ndims", "reshape", "repmat", "cat", "horzcat", ...
  "vertcat", "diag", "trace", "rank", "det", "inv", "pinv", "transpose", ...
  "kron", "find", "sort", "unique", "fliplr", "flipud", "circshift", ...
  "isempty", "any", "all", "end", ...
  ## Álgebra lineal
  "eig", "svd", "lu", "qr", "chol", "expm", "logm", "sqrtm", "null", "orth", ...
  "norm", "cond", "linsolve", "mldivide", "cross", "dot", ...
  ## Matemática elemental
  "abs", "sign", "sqrt", "exp", "log", "log10", "log2", "sin", "cos", "tan", ...
  "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "real", "imag", ...
  "conj", "angle", "arg", "round", "floor", "ceil", "fix", "mod", "rem", ...
  "max", "min", "sum", "prod", "cumsum", "cumprod", "mean", "median", "std", ...
  "var", "diff", "hypot", "pi", "e", "Inf", "NaN", "isnan", "isinf", "isreal", ...
  ## Polinomios
  "roots", "poly", "polyval", "polyfit", "conv", "deconv", "residue", ...
  "polyder", "polyint", ...
  ## Integración, ecuaciones y optimización
  "trapz", "cumtrapz", "interp1", "ode45", "ode23", "fzero", "fminsearch", ...
  "fminbnd", "fsolve", "quad", "integral", ...
  ## Señales
  "filter", "fft", "ifft", ...
  ## Gráficos
  "plot", "plot3", "semilogx", "semilogy", "loglog", "stem", "stairs", "bar", ...
  "hist", "polar", "mesh", "surf", "contour", "meshgrid", "figure", "subplot", ...
  "hold", "grid", "axis", "xlabel", "ylabel", "zlabel", "title", "legend", ...
  "text", "line", "close", "clf", "gca", "gcf", "set", "get", "print", ...
  "saveas", "xlim", "ylim", "colorbar", "colormap", ...
  ## Entrada/salida
  "disp", "display", "printf", "fprintf", "sprintf", "num2str", "str2num", ...
  "str2double", "mat2str", "input", "keyboard", "load", "save", "error", ...
  "warning", "format", ...
  ## Strings y celdas
  "strcat", "strsplit", "strjoin", "strrep", "strcmp", "strcmpi", "strtrim", ...
  "upper", "lower", "regexp", "regexprep", "cell", "cellfun", "arrayfun", ...
  "struct", "fieldnames", "isfield", "num2cell", "cell2mat", ...
  ## Control de flujo y entorno
  "clear", "clc", "who", "whos", "exist", "isa", "class", "func2str", ...
  "str2func", "feval", "eval", "tic", "toc", "pause", "pkg", "help", "doc", ...
  "nargin", "nargout", "numel", "double", "int32", "logical", "true", "false"
};

pkg load control
pkg load symbolic

entries = {};
entries = scan_package (entries, "control");
entries = scan_package (entries, "symbolic");

ncore = 0;
for i = 1:numel (core)
  n0 = numel (entries);
  entries = add_entry (entries, core{i}, "", "octave", core{i});
  ncore += numel (entries) - n0;
endfor
printf ("octave: %d de %d funciones básicas\n", ncore, numel (core));

## Quitar duplicados exactos (misma función, misma clase)
keys = cellfun (@(e) [e.class "/" e.name], entries, "UniformOutput", false);
[~, idx] = unique (keys, "stable");
entries = entries(idx);

docs = struct ();
docs.octaveVersion = OCTAVE_VERSION;
docs.generated = datestr (now, "yyyy-mm-dd");
docs.entries = [entries{:}];

if (! exist ("docs", "dir"))
  mkdir ("docs");
endif
fid = fopen ("docs/octave-docs.json", "w");
fputs (fid, jsonencode (docs));
fclose (fid);
printf ("%d entradas en docs/octave-docs.json\n", numel (entries));
