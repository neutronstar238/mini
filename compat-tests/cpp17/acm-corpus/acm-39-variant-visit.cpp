#include <bits/stdc++.h>
using namespace std;
int main(){variant<int,string>x=8;auto f=[](auto v)->string{using T=decay_t<decltype(v)>;if constexpr(is_same_v<T,int>)return to_string(v);else return v;};cout<<visit(f,x)<<"\n";}
